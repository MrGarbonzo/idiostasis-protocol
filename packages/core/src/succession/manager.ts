import { randomBytes } from 'node:crypto';
import type { AttestationProvider, ProtocolConfig, GuardianRecord } from '../interfaces.js';
import { ProtocolDatabase, ProtocolEventType } from '../database/db.js';
import { SnapshotManager } from '../database/snapshot.js';
import type { DbSnapshot } from '../database/snapshot.js';
import { KeyExchangeSession } from '../vault/exchange.js';
import type { WrappedKey } from '../vault/exchange.js';
import type { VaultKeyManager } from '../vault/key-manager.js';
import { selectSuccessor } from './selector.js';

export class SuccessionExhaustedError extends Error {
  constructor() {
    super('All succession candidates exhausted');
    this.name = 'SuccessionExhaustedError';
  }
}

/**
 * Transport function for contacting backup agent candidates during succession.
 * Injectable for testing.
 */
export type SuccessionTransport = {
  /** Contact candidate at /api/backup/ready, return their attestation payload. */
  contactCandidate(networkAddress: string): Promise<CandidateReadyResponse>;
  /** Send vault key + snapshot to candidate, wait for confirmation. */
  sendSuccessionPayload(
    networkAddress: string,
    payload: { encryptedVaultKey: WrappedKey; dbSnapshot: DbSnapshot; guardianX25519PublicKey: Uint8Array },
  ): Promise<boolean>;
};

export interface CandidateReadyResponse {
  rtmr3: string;
  x25519PublicKey: Uint8Array;
  ed25519PublicKey: Uint8Array;
  ed25519Signature: Uint8Array;
}

/**
 * Minimal ERC-8004 interface to avoid coupling core to erc8004-client.
 */
export interface Erc8004Checker {
  getLivePrimaryAddress(): Promise<string | null>;
}

/**
 * Guardian-side succession orchestrator.
 * Runs when a guardian detects primary liveness failure.
 */
export class SuccessionManager {
  private readonly db: ProtocolDatabase;
  private readonly config: ProtocolConfig;
  private readonly teeInstanceId: string;
  private readonly vaultKey: Uint8Array;
  private readonly onSuccessionComplete: (newPrimaryAddress: string) => Promise<void>;
  private readonly erc8004Checker: Erc8004Checker | null;

  constructor(
    db: ProtocolDatabase,
    config: ProtocolConfig,
    teeInstanceId: string,
    vaultKey: Uint8Array,
    onSuccessionComplete: (newPrimaryAddress: string) => Promise<void>,
    erc8004Checker?: Erc8004Checker,
  ) {
    this.db = db;
    this.config = config;
    this.teeInstanceId = teeInstanceId;
    this.vaultKey = vaultKey;
    this.onSuccessionComplete = onSuccessionComplete;
    this.erc8004Checker = erc8004Checker ?? null;
  }

  async initiateSuccession(
    transport: SuccessionTransport,
    signer: (data: Uint8Array) => Promise<Uint8Array>,
  ): Promise<void> {
    const backups = this.db.listBackupAgents('standby');
    const successor = selectSuccessor(backups);
    if (!successor) {
      throw new SuccessionExhaustedError();
    }

    this.db.logEvent(ProtocolEventType.SUCCESSION_INITIATED);

    // Read approved RTMR3 from DB config
    const approvedRtmr3 = this.db.getConfig('agent_rtmr3');

    // Build ordered candidate list using selector sort logic
    const candidates = backups
      .filter(a => a.status === 'standby')
      .sort((a, b) => {
        if (b.heartbeatStreak !== a.heartbeatStreak) return b.heartbeatStreak - a.heartbeatStreak;
        const aTime = a.registeredAt.getTime();
        const bTime = b.registeredAt.getTime();
        if (aTime !== bTime) return aTime - bTime;
        return a.teeInstanceId.localeCompare(b.teeInstanceId);
      });

    for (const candidate of candidates) {
      try {
        // Contact candidate
        const response = await transport.contactCandidate(candidate.networkAddress);

        // Verify RTMR3
        if (approvedRtmr3 && response.rtmr3 !== approvedRtmr3) {
          console.warn(`[succession] candidate ${candidate.id} RTMR3 mismatch: expected ${approvedRtmr3}, got ${response.rtmr3}`);
          continue;
        }

        // Key exchange
        const session = await KeyExchangeSession.generate();
        const sharedSecret = session.computeSharedSecret(response.x25519PublicKey);
        const encryptedVaultKey = session.wrapVaultKey(this.vaultKey, sharedSecret);

        // Create snapshot
        const snapshotMgr = new SnapshotManager(this.db, this.vaultKey, this.teeInstanceId);
        const dbSnapshot = await snapshotMgr.createSnapshot(signer);

        // Send to candidate (include guardian's X25519 public key so backup can compute shared secret)
        const confirmed = await transport.sendSuccessionPayload(
          candidate.networkAddress,
          { encryptedVaultKey, dbSnapshot, guardianX25519PublicKey: session.getPublicKeys().x25519 },
        );

        if (!confirmed) {
          console.warn(`[succession] candidate ${candidate.id} did not confirm`);
          continue;
        }

        this.db.logEvent(ProtocolEventType.SUCCESSION_COMPLETE, candidate.networkAddress);
        await this.onSuccessionComplete(candidate.networkAddress);
        return;
      } catch (err) {
        console.warn(`[succession] candidate ${candidate.id} failed:`, err);
        continue;
      }
    }

    throw new SuccessionExhaustedError();
  }

  /**
   * Check if another primary has come online (stand-down check).
   * Returns true if ERC-8004 registry shows a different live primary.
   */
  async checkAndStandDown(currentPrimaryAddress: string): Promise<boolean> {
    if (!this.erc8004Checker) return false;
    const livePrimary = await this.erc8004Checker.getLivePrimaryAddress();
    if (livePrimary && livePrimary !== currentPrimaryAddress) {
      return true;
    }
    return false;
  }
}

// --- New primary side: succession receiver functions ---

export interface BackupReadyRequest {
  guardianTeeInstanceId: string;
  guardianRtmr3: string;
  guardianX25519PublicKey: Uint8Array;
  guardianEd25519PublicKey: Uint8Array;
  guardianEd25519Signature: Uint8Array;
}

export interface BackupReadyResponse {
  rtmr3: string;
  x25519PublicKey: Uint8Array;
  ed25519PublicKey: Uint8Array;
  ed25519Signature: Uint8Array;
}

/**
 * Handle /api/backup/ready — guardian contacts backup agent to initiate succession.
 * Returns own attestation payload for guardian to verify.
 */
export async function handleBackupReadyRequest(
  _req: BackupReadyRequest,
  ownRtmr3: string,
): Promise<BackupReadyResponse> {
  const session = await KeyExchangeSession.generate();
  const keys = session.getPublicKeys();
  return {
    rtmr3: ownRtmr3,
    x25519PublicKey: keys.x25519,
    ed25519PublicKey: keys.ed25519,
    ed25519Signature: keys.signature,
  };
}

/**
 * Handle succession payload receive — new primary receives vault key + snapshot.
 * Does NOT generate new vault key here — vault key rotation happens AFTER
 * the new primary updates ERC-8004. See rotateVaultKey().
 * Does NOT update ERC-8004 — that is agent orchestration, not protocol.
 */
export async function handleSuccessionReceive(
  encryptedVaultKey: WrappedKey,
  dbSnapshot: DbSnapshot,
  exchangeSession: KeyExchangeSession,
  sharedSecret: Uint8Array,
  currentDb: ProtocolDatabase,
  lastKnownSeqNum: number,
): Promise<Uint8Array> {
  // Unwrap vault key
  const vaultKey = exchangeSession.unwrapVaultKey(encryptedVaultKey, sharedSecret);

  // Validate and apply snapshot
  const snapshotMgr = new SnapshotManager(currentDb, vaultKey, '');
  if (!snapshotMgr.validateSequenceNum(dbSnapshot, lastKnownSeqNum)) {
    throw new Error('Snapshot sequence number is not strictly increasing');
  }
  await snapshotMgr.applySnapshot(dbSnapshot);

  // TODO: vault key rotation happens after ERC-8004 update (Decision 6)
  return vaultKey;
}

/**
 * Transport function for sending rotated vault key to guardians.
 */
export type VaultKeyTransport = (
  guardian: GuardianRecord,
  wrappedKey: WrappedKey,
  snapshot: DbSnapshot,
  primaryX25519PublicKey: Uint8Array,
) => Promise<boolean>;

/**
 * Vault key rotation — called after new primary updates ERC-8004 (Decision 6).
 * Generates new vault key, re-encrypts DB, distributes to guardians.
 * Old key is zeroed after distribution.
 */
export async function rotateVaultKey(
  db: ProtocolDatabase,
  oldVaultKey: Uint8Array,
  vaultKeyManager: VaultKeyManager,
  guardians: GuardianRecord[],
  keyExchangeFn: (guardian: GuardianRecord) => Promise<{ session: KeyExchangeSession; sharedSecret: Uint8Array }>,
  transport: VaultKeyTransport,
  signer: (data: Uint8Array) => Promise<Uint8Array>,
  teeInstanceId: string,
): Promise<Uint8Array> {
  // 1. Generate new vault key inside TEE
  const newVaultKey = new Uint8Array(randomBytes(32));

  // 2. Create snapshot re-encrypted with new key
  const snapshotMgr = new SnapshotManager(db, newVaultKey, teeInstanceId);

  // 3. Distribute to all active guardians via key exchange
  const activeGuardians = guardians.filter(g => g.status === 'active');
  for (const guardian of activeGuardians) {
    try {
      const { session, sharedSecret } = await keyExchangeFn(guardian);
      const wrappedKey = session.wrapVaultKey(newVaultKey, sharedSecret);
      const snapshot = await snapshotMgr.createSnapshot(signer);
      const sent = await transport(guardian, wrappedKey, snapshot, session.getPublicKeys().x25519);
      if (sent) {
        console.log(`[vault-rotation] distributed new key to guardian ${guardian.teeInstanceId}`);
      } else {
        console.warn(`[vault-rotation] guardian ${guardian.teeInstanceId} rejected key update`);
      }
    } catch (err) {
      console.warn(`[vault-rotation] failed to distribute to guardian ${guardian.id}:`, err);
    }
  }

  // 4. Zero old vault key in memory
  oldVaultKey.fill(0);

  // 5. Store new vault key via VaultKeyManager
  vaultKeyManager.replaceKey(newVaultKey);
  await vaultKeyManager.seal();

  // 6. Log rotation event
  db.logEvent(ProtocolEventType.VAULT_KEY_ROTATED);

  return newVaultKey;
}
