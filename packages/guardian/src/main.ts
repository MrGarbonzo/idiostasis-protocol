import { join } from 'node:path';
import {
  loadConfig,
  ProtocolDatabase,
  SnapshotManager,
} from '@idiostasis/core';
import type { DbSnapshot, WrappedKey } from '@idiostasis/core';
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
}

// Auto-invoke when run directly
startGuardian().catch((err) => {
  console.error('[guardian] fatal:', err);
  process.exit(1);
});
