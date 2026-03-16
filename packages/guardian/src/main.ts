import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  loadConfig,
  ProtocolDatabase,
  SnapshotManager,
  KeyExchangeSession,
} from '@idiostasis/core';
import type { DbSnapshot, ProtocolConfig, WrappedKey } from '@idiostasis/core';
import { ERC8004Client } from '@idiostasis/erc8004-client';
import { LivenessMonitor } from './liveness/monitor.js';
import { SuccessionHandler } from './succession/handler.js';
import { PeerRegistry } from './peers/registry.js';
import { Erc8004Discovery } from './discovery/erc8004.js';
import { GuardianHttpServer } from './guardian-http-server.js';
import type { AdmissionPayload } from './http-server.js';

/**
 * Guardian entry point.
 *
 * Startup sequence:
 * 1. Load config
 * 2. Initialize ProtocolDatabase (guardian's own DB)
 * 3. Guardian starts WITHOUT vault key — receives it during admission
 * 4. Initialize PeerRegistry
 * 5. Initialize Erc8004Discovery (stub)
 * 6. Initialize LivenessMonitor and SuccessionHandler
 * 7. Start Express HTTP server
 * 8. Log ready
 */
export async function startGuardian(): Promise<void> {
  const config = loadConfig();
  const dataDir = process.env.GUARDIAN_DATA_DIR ?? '/data';
  const dbPath = join(dataDir, 'guardian.db');
  const peersDbPath = join(dataDir, 'peers.db');
  const teeInstanceId = process.env.TEE_INSTANCE_ID ?? `dev-guardian-${Date.now()}`;
  const port = parseInt(process.env.PORT ?? '3000', 10);

  // Guardian starts without vault key — receives it on admission
  let vaultKey: Uint8Array | null = null;
  let db: ProtocolDatabase | null = null;
  let snapshotManager: SnapshotManager | null = null;

  // If VAULT_KEY env var is set (hex), use it (for recovery scenarios)
  const vaultKeyHex = process.env.VAULT_KEY;
  if (vaultKeyHex) {
    vaultKey = new Uint8Array(Buffer.from(vaultKeyHex, 'hex'));
    db = new ProtocolDatabase(dbPath, vaultKey);
    snapshotManager = new SnapshotManager(db, vaultKey, teeInstanceId);
  }

  const peerRegistry = new PeerRegistry(peersDbPath);

  // ERC-8004 discovery — requires BASE_RPC_URL, ERC8004_REGISTRY_ADDRESS, and ERC8004_TOKEN_ID
  const baseRpcUrl = process.env.BASE_RPC_URL ?? '';
  const registryAddress = process.env.ERC8004_REGISTRY_ADDRESS ?? '';
  const agentTokenId = parseInt(process.env.ERC8004_TOKEN_ID ?? '0', 10);
  const baseNetwork = (process.env.BASE_NETWORK ?? 'base-sepolia') as 'base-sepolia' | 'base';

  let discovery: Erc8004Discovery | null = null;
  if (agentTokenId > 0 && baseRpcUrl) {
    const erc8004Client = new ERC8004Client(baseRpcUrl, registryAddress, baseNetwork);
    discovery = new Erc8004Discovery(erc8004Client, agentTokenId);
    console.log(`[guardian] ERC-8004 discovery enabled for token ID ${agentTokenId}`);
  } else {
    console.warn('[guardian] ERC-8004 discovery disabled — ERC8004_TOKEN_ID or BASE_RPC_URL not set');
  }

  // Dummy signer for now — real signing uses TEE Ed25519
  const dummySigner = async (_data: Uint8Array) => new Uint8Array(64);

  // ERC-8004 checker for succession
  const erc8004Checker = {
    async getLivePrimaryAddress(): Promise<string | null> {
      if (!discovery) return null;
      try {
        return await discovery.discoverPrimary();
      } catch {
        return null;
      }
    },
  };

  // Create a temporary DB for liveness monitoring even without vault key
  // (guardian can receive pings before admission)
  const monitorDb = db ?? new ProtocolDatabase(join(dataDir, 'monitor.db'), new Uint8Array(32));

  // Create succession handler (will only work once vault key is set)
  const successionHandler = vaultKey && db
    ? new SuccessionHandler(db, config, vaultKey, teeInstanceId, erc8004Checker)
    : null;

  const dummySuccession = {
    async initiate() {
      if (successionHandler) await successionHandler.initiate();
      else console.warn('[guardian] succession attempted before admission');
    },
    isInProgress() {
      return successionHandler?.isInProgress() ?? false;
    },
  };

  const liveness = new LivenessMonitor(config, monitorDb, dummySuccession);
  liveness.start();

  // Admission handler — receives vault key from primary
  const onAdmission = async (payload: AdmissionPayload) => {
    if (!vaultKey) {
      // TODO: Decrypt vault key from payload using key exchange
      console.log('[guardian] received admission — vault key provisioned');

      // Store primary's Ed25519 public key for ping signature verification
      if (payload.primaryEd25519PublicKey) {
        liveness.setPrimaryPublicKey(payload.primaryEd25519PublicKey);
        console.log('[guardian] primary Ed25519 public key stored for ping verification');
      }
    }
  };

  const snapshotProvider = async (): Promise<DbSnapshot | null> => {
    if (!snapshotManager) return null;
    return snapshotManager.createSnapshot(dummySigner);
  };

  // Start Express HTTP server
  const httpServer = new GuardianHttpServer(port, liveness, onAdmission, snapshotProvider);
  await httpServer.start();

  console.log(`[guardian] ready, teeInstanceId=${teeInstanceId}, waiting for primary admission`);

  // Initiate admission to primary agent
  const agentDomain = process.env.AGENT_DOMAIN ?? '';
  const agentUrl = process.env.AGENT_URL ?? '';

  // AGENT_URL takes precedence (e.g. http://67.43.239.18:3001)
  // AGENT_DOMAIN falls back to http://{domain}:3001
  const agentBaseUrl = agentUrl ||
    (agentDomain ? `http://${agentDomain}:3001` : '');

  if (agentBaseUrl) {
    // Start admission in background — do not block server startup
    initiateAdmission(agentBaseUrl, teeInstanceId, port, config)
      .catch(err => console.error('[guardian] admission initiation failed:', err));
  } else {
    console.warn(
      '[guardian] AGENT_DOMAIN or AGENT_URL not set — ' +
      'admission must be triggered manually',
    );
  }
}

async function initiateAdmission(
  agentBaseUrl: string,
  teeInstanceId: string,
  port: number,
  config: ProtocolConfig,
): Promise<void> {
  console.log(`[guardian] initiating admission to ${agentBaseUrl}`);

  // Generate real X25519 + Ed25519 keypair using KeyExchangeSession
  const session = await KeyExchangeSession.generate();
  const { x25519, ed25519, signature } = session.getPublicKeys();

  // Build admission request
  const nonce = randomUUID();
  const timestamp = Date.now();

  // Self-reported RTMR3 — read from TEE path or env var
  const selfRtmr3 = await readRtmr3();

  const body = JSON.stringify({
    role: 'guardian',
    networkAddress: `${process.env.SECRETVM_DOMAIN ?? teeInstanceId}:${port}`,
    teeInstanceId,
    domain: process.env.SECRETVM_DOMAIN ?? '',
    nonce,
    timestamp,
    rtmr3: selfRtmr3,
    x25519PublicKey: Array.from(x25519),
    ed25519PublicKey: Array.from(ed25519),
    ed25519Signature: Array.from(signature),
  });

  // Retry loop — agent may not be ready yet on first boot
  let attempts = 0;
  const maxAttempts = 10;
  const retryDelayMs = 15_000;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      const res = await fetch(`${agentBaseUrl}/api/admission`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(10_000),
      });

      const result = await res.json() as {
        accepted: boolean;
        reason?: string;
        vaultKey?: unknown;
        dbSnapshot?: unknown;
      };

      if (result.accepted) {
        console.log('[guardian] admission accepted by primary agent');
        // TODO: Phase 12 — unwrap vault key and apply DB snapshot
        console.log('[guardian] vault key and snapshot received — TODO: apply');
        return;
      }

      console.warn(
        `[guardian] admission rejected: ${result.reason} ` +
        `(attempt ${attempts}/${maxAttempts})`,
      );

      // Don't retry on hard rejections
      if (result.reason === 'rtmr3_mismatch' ||
          result.reason === 'invalid_signature' ||
          result.reason === 'missing_domain') {
        console.error(
          '[guardian] admission hard-rejected — ' +
          'fix configuration and redeploy',
        );
        return;
      }
    } catch (err) {
      console.warn(
        `[guardian] admission attempt ${attempts}/${maxAttempts} failed: ${err}`,
      );
    }

    if (attempts < maxAttempts) {
      console.log(`[guardian] retrying admission in ${retryDelayMs / 1000}s...`);
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
  }

  console.error('[guardian] admission failed after all attempts');
}

async function readRtmr3(): Promise<string> {
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile('/dev/attestation/rtmr3', 'utf-8');
    return raw.trim();
  } catch { /* not in TEE */ }
  try {
    const envVal = process.env.AGENT_RTMR3 ?? process.env.RTMR3;
    if (envVal) return envVal;
  } catch { /* no env */ }
  return 'dev-measurement';
}
