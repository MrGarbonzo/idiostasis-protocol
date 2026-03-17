import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import {
  loadConfig,
  ProtocolDatabase,
  SnapshotManager,
  KeyExchangeSession,
} from '@idiostasis/core';
import type {
  DbSnapshot,
  ProtocolConfig,
  WrappedKey,
  SuccessionTransport,
  CandidateReadyResponse,
} from '@idiostasis/core';
import { ERC8004Client } from '@idiostasis/erc8004-client';
import { LivenessMonitor } from './liveness/monitor.js';
import { SuccessionHandler } from './succession/handler.js';
import { PeerRegistry } from './peers/registry.js';
import { Erc8004Discovery } from './discovery/erc8004.js';
import { GuardianHttpServer } from './guardian-http-server.js';
import type { AdmissionPayload } from './http-server.js';

interface AdmissionResultData {
  vaultKey: Uint8Array;
  dbSnapshot: DbSnapshot;
  primaryEd25519PublicKey: Uint8Array;
}

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
 * 9. Initiate admission — on success, initialize DB and wire real succession
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

  // ERC8004_TOKEN_ID: token ID of the agent in the ERC-8004 registry.
  // Set this to enable registry-based discovery + succession handling.
  // When not set, guardian falls back to AGENT_URL.
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

  // Start with dummy succession handler — replaced after admission
  const dummySuccession = {
    async initiate() {
      console.warn('[guardian] succession attempted before admission');
    },
    isInProgress() {
      return false;
    },
  };

  const liveness = new LivenessMonitor(config, monitorDb, dummySuccession);
  liveness.start();

  // Admission handler — receives vault key from primary (passive path via HTTP)
  const onAdmission = async (payload: AdmissionPayload) => {
    if (payload.primaryEd25519PublicKey) {
      liveness.setPrimaryPublicKey(payload.primaryEd25519PublicKey);
      console.log('[guardian] primary Ed25519 public key stored for ping verification');
    }
  };

  const snapshotProvider = async (): Promise<DbSnapshot | null> => {
    if (!snapshotManager) return null;
    return snapshotManager.createSnapshot(dummySigner);
  };

  const onSnapshotUpdate = async (snapshot: DbSnapshot) => {
    if (snapshotManager && snapshot) {
      await snapshotManager.applySnapshot(snapshot);
      console.log('[guardian] snapshot applied — DB updated');
    }
  };

  // Start Express HTTP server
  const httpServer = new GuardianHttpServer(port, liveness, onAdmission, snapshotProvider, undefined, onSnapshotUpdate);
  await httpServer.start();

  console.log(`[guardian] ready, teeInstanceId=${teeInstanceId}, waiting for primary admission`);

  const ownDomain = process.env.SECRETVM_DOMAIN ?? '(auto — agent uses source IP)';
  console.log(`[guardian] own domain: ${ownDomain}`);

  // Initiate admission to primary agent
  const agentBaseUrl = await resolveAgentUrl(discovery);

  if (agentBaseUrl) {
    const admissionResult = await initiateAdmission(agentBaseUrl, teeInstanceId, port, config);

    if (admissionResult) {
      // Store vault key
      vaultKey = admissionResult.vaultKey;

      // Initialize DB with vault key
      db = new ProtocolDatabase(dbPath, vaultKey);
      snapshotManager = new SnapshotManager(db, vaultKey, teeInstanceId);

      // Apply snapshot to DB
      await snapshotManager.applySnapshot(admissionResult.dbSnapshot);
      console.log('[guardian] DB snapshot applied — fully initialized');

      // Store primary public key for ping verification
      liveness.setPrimaryPublicKey(admissionResult.primaryEd25519PublicKey);

      // Wire real succession handler
      const realSuccessionHandler = new SuccessionHandler(
        db, config, vaultKey, teeInstanceId, erc8004Checker,
      );
      realSuccessionHandler.setTransport(createSuccessionTransport(teeInstanceId));
      realSuccessionHandler.setSigner(dummySigner);

      // Replace dummy succession with real one in liveness monitor
      liveness.setSuccessionHandler(realSuccessionHandler);
      console.log('[guardian] real succession handler wired');

      // Save vault key to disk
      await mkdir(dataDir, { recursive: true });
      await writeFile(
        join(dataDir, 'vault-key.json'),
        JSON.stringify({ key: Buffer.from(vaultKey).toString('hex') }),
        'utf-8',
      );
      console.log('[guardian] vault key stored to disk');
    }
  } else {
    console.warn(
      '[guardian] ERC-8004 discovery failed — ' +
      'admission must be triggered manually',
    );
  }
}

function createSuccessionTransport(guardianTeeInstanceId: string): SuccessionTransport {
  return {
    async contactCandidate(networkAddress: string): Promise<CandidateReadyResponse> {
      const url = networkAddress.startsWith('http')
        ? `${networkAddress}/api/backup/ready`
        : `http://${networkAddress}/api/backup/ready`;

      console.log(`[succession] contacting backup candidate at ${url}`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          guardianTeeInstanceId,
          guardianRtmr3: await readRtmr3(),
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) throw new Error(`backup/ready failed: ${res.status}`);
      const data = await res.json() as Record<string, unknown>;

      return {
        rtmr3: data.rtmr3 as string,
        x25519PublicKey: deserializeKey(data.x25519PublicKey),
        ed25519PublicKey: deserializeKey(data.ed25519PublicKey),
        ed25519Signature: deserializeKey(data.ed25519Signature),
      };
    },

    async sendSuccessionPayload(
      networkAddress: string,
      payload: { encryptedVaultKey: WrappedKey; dbSnapshot: DbSnapshot; guardianX25519PublicKey: Uint8Array },
    ): Promise<boolean> {
      const url = networkAddress.startsWith('http')
        ? `${networkAddress}/api/backup/confirm`
        : `http://${networkAddress}/api/backup/confirm`;

      console.log(`[succession] sending vault key + snapshot to ${url}`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          encryptedVaultKey: payload.encryptedVaultKey,
          dbSnapshot: payload.dbSnapshot,
          guardianX25519PublicKey: Array.from(payload.guardianX25519PublicKey),
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) return false;
      const data = await res.json() as { ok: boolean };
      return data.ok === true;
    },
  };
}

function deserializeKey(value: unknown): Uint8Array {
  if (Array.isArray(value)) return new Uint8Array(value);
  if (typeof value === 'string') return new Uint8Array(Buffer.from(value, 'base64'));
  if (typeof value === 'object' && value !== null) {
    // JSON.stringify(Uint8Array) produces {"0":1,"1":2,...}
    const keys = Object.keys(value);
    return new Uint8Array(keys.map(k => (value as Record<string, number>)[k]));
  }
  return new Uint8Array(0);
}

async function resolveAgentUrl(discovery: Erc8004Discovery | null): Promise<string> {
  if (!discovery) {
    console.error('[guardian] ERC-8004 discovery not configured — ERC8004_TOKEN_ID and BASE_RPC_URL are required');
    return '';
  }
  try {
    const discovered = await discovery.discoverPrimary();
    if (discovered) {
      const url = new URL(discovered);
      const baseUrl = `${url.protocol}//${url.host}`;
      console.log(`[guardian] discovered agent via ERC-8004: ${discovered}`);
      console.log(`[guardian] agent base URL: ${baseUrl}`);
      return baseUrl;
    }
    console.error('[guardian] ERC-8004 discovery returned null — agent not registered or token ID wrong');
    return '';
  } catch (err) {
    console.error(`[guardian] ERC-8004 discovery failed: ${err}`);
    return '';
  }
}

async function initiateAdmission(
  agentBaseUrl: string,
  teeInstanceId: string,
  port: number,
  config: ProtocolConfig,
): Promise<AdmissionResultData | null> {
  console.log(`[guardian] initiating admission to ${agentBaseUrl}`);

  // Self-reported RTMR3 — read from TEE path or env var
  const selfRtmr3 = await readRtmr3();

  // Retry loop — agent may not be ready yet on first boot
  let attempts = 0;
  const maxAttempts = 10;
  const retryDelayMs = 15_000;

  while (attempts < maxAttempts) {
    attempts++;

    // Generate fresh keypair, nonce, and timestamp for each attempt
    // so the agent's nonce-replay check doesn't reject retries
    const session = await KeyExchangeSession.generate();
    const { x25519, ed25519, signature } = session.getPublicKeys();
    const nonce = randomUUID();
    const timestamp = Date.now();

    const body = JSON.stringify({
      role: 'guardian',
      networkAddress: `http://source-ip:${port}`,
      teeInstanceId,
      nonce,
      timestamp,
      rtmr3: selfRtmr3,
      x25519PublicKey: Array.from(x25519),
      ed25519PublicKey: Array.from(ed25519),
      ed25519Signature: Array.from(signature),
    });

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
        primaryX25519PublicKey?: unknown;
        primaryEd25519PublicKey?: unknown;
        vaultKey?: WrappedKey;
        dbSnapshot?: DbSnapshot;
      };

      if (result.accepted) {
        console.log('[guardian] admission accepted by primary agent');

        if (!result.vaultKey || !result.dbSnapshot || !result.primaryX25519PublicKey) {
          console.error('[guardian] admission accepted but missing vault key, snapshot, or primary keys');
          return null;
        }

        // Compute shared secret and unwrap vault key
        const primaryX25519 = deserializeKey(result.primaryX25519PublicKey);
        const sharedSecret = session.computeSharedSecret(primaryX25519);
        const unwrappedVaultKey = session.unwrapVaultKey(result.vaultKey, sharedSecret);

        console.log('[guardian] vault key unwrapped successfully');

        return {
          vaultKey: unwrappedVaultKey,
          dbSnapshot: result.dbSnapshot,
          primaryEd25519PublicKey: deserializeKey(result.primaryEd25519PublicKey),
        };
      }

      console.warn(
        `[guardian] admission rejected: ${result.reason} ` +
        `(attempt ${attempts}/${maxAttempts})`,
      );

      // Hard rejections — configuration problem on this guardian, stop immediately
      if (result.reason === 'rtmr3_mismatch' ||
          result.reason === 'invalid_signature' ||
          result.reason === 'missing_domain') {
        console.error(
          '[guardian] admission hard-rejected — ' +
          'fix configuration and redeploy',
        );
        return null;
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
  return null;
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
