/**
 * DB Sync — manages encrypted database snapshot distribution from agent to guardians.
 *
 * The agent is the DB master; guardians hold encrypted replicas.
 * Snapshots are encrypted with the vault key (AES-256-GCM) and distributed
 * via signed envelopes.
 */
import { createHash } from 'node:crypto';
import type { TEESigner } from '../shared/tee-signer.js';
import type { TrustStore } from '../shared/trust-store.js';
import { createEnvelope, verifyEnvelope, parsePayload, type SignedEnvelope } from '../shared/signed-envelope.js';
import { encrypt, decrypt, type EncryptedData } from '../shared/vault.js';
import { verifyInlineAttestation } from '../shared/attestation-verifier.js';
import { formatDbSyncSent, formatDbSyncReceived, formatDbSyncRejected } from '../shared/telegram-protocol.js';

// ── Types ────────────────────────────────────────────────────────

export interface DBSnapshot {
  /** AES-256-GCM encrypted database (base64). */
  encryptedDb: string;
  /** Initialization vector (hex). */
  iv: string;
  /** GCM authentication tag (hex). */
  authTag: string;
  /** Monotonically increasing sequence number. */
  sequenceNum: number;
  /** SHA-256 checksum of the plaintext database. */
  checksum: string;
  /** Fresh attestation quote for per-interaction verification (optional). */
  attestationQuote?: string;
}

export interface DBSyncConfig {
  /** This node's identifier. */
  nodeId: string;
  /** TEE signer for envelope signing. */
  signer: TEESigner;
  /** Vault key for DB encryption. */
  vaultKey: Buffer;
  /** Trust store for peer verification. */
  trustStore: TrustStore;
  /** Optional callback for trust events. */
  onEvent?: (msg: string) => void;
  /** Approved code measurement hashes for inline attestation (empty = accept all). */
  approvedMeasurements?: Set<string>;
  /** If true, reject snapshots that lack an inline attestation quote. */
  requireAttestation?: boolean;
}

// ── Snapshot Creation (Agent Side) ───────────────────────────────

export class DBSnapshotManager {
  private sequenceNum = 0;
  private config: DBSyncConfig;

  constructor(config: DBSyncConfig) {
    this.config = config;
  }

  /** Get the current sequence number. */
  get currentSequence(): number {
    return this.sequenceNum;
  }

  /** Set sequence number (e.g., after recovery). */
  setSequence(seq: number): void {
    this.sequenceNum = seq;
  }

  /**
   * Create an encrypted snapshot of the database.
   * Returns a signed envelope ready for distribution.
   */
  async createSnapshot(dbBuffer: Buffer): Promise<SignedEnvelope> {
    this.sequenceNum++;

    // Compute plaintext checksum
    const checksum = createHash('sha256').update(dbBuffer).digest('hex');

    // Encrypt with vault key
    const encrypted = encrypt(this.config.vaultKey, dbBuffer);

    const snapshot: DBSnapshot = {
      encryptedDb: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      sequenceNum: this.sequenceNum,
      checksum,
    };

    // Wrap in signed envelope
    return createEnvelope({
      sender: this.config.nodeId,
      action: 'db.snapshot',
      payload: snapshot,
      signer: this.config.signer,
    });
  }

  /**
   * Distribute a snapshot to all trusted peers.
   * Returns results per peer.
   */
  async distributeSnapshot(
    dbBuffer: Buffer,
    sendFn: (peerId: string, endpoint: string, envelope: SignedEnvelope) => Promise<boolean>,
  ): Promise<{ peerId: string; success: boolean }[]> {
    const envelope = await this.createSnapshot(dbBuffer);
    const peers = this.config.trustStore.listPeers();
    const results: { peerId: string; success: boolean }[] = [];

    for (const peer of peers) {
      if (peer.id === this.config.nodeId) continue; // Skip self
      if (!peer.endpoint) continue;

      try {
        const ok = await sendFn(peer.id, peer.endpoint, envelope);
        results.push({ peerId: peer.id, success: ok });
      } catch {
        results.push({ peerId: peer.id, success: false });
      }
    }

    const sentCount = results.filter((r) => r.success).length;
    if (sentCount > 0) {
      const sizeKB = Math.round(dbBuffer.length / 1024);
      this.config.onEvent?.(formatDbSyncSent({
        seq: this.sequenceNum,
        peers: sentCount,
        sizeKB,
      }));
    }

    return results;
  }
}

// ── Snapshot Reception (Guardian Side) ───────────────────────────

export class DBSnapshotReceiver {
  private config: DBSyncConfig;
  private latestSequence = 0;
  private latestEncrypted: DBSnapshot | null = null;

  constructor(config: DBSyncConfig) {
    this.config = config;
  }

  /** Get the latest received sequence number. */
  get currentSequence(): number {
    return this.latestSequence;
  }

  /**
   * Process an incoming db.snapshot envelope.
   * Verifies the envelope, stores the encrypted snapshot.
   * Optionally decrypts and verifies checksum (sentry nodes).
   */
  async receiveSnapshot(
    envelope: SignedEnvelope,
    opts?: { decryptAndVerify?: boolean },
  ): Promise<{ accepted: boolean; sequenceNum?: number; error?: string }> {
    // Look up sender's pubkey
    const senderPeer = this.config.trustStore.getPeer(envelope.sender);
    if (!senderPeer) {
      const result = { accepted: false as const, error: `Unknown sender: ${envelope.sender}` };
      this.config.onEvent?.(formatDbSyncRejected({ fromPeerId: envelope.sender, reason: result.error }));
      return result;
    }

    // Verify envelope
    const verification = verifyEnvelope({
      envelope,
      senderPubkeyBase64: senderPeer.ed25519PubkeyBase64,
      signer: this.config.signer,
      nonceTracker: this.config.trustStore.getNonceTracker(),
    });

    if (!verification.valid) {
      const error = `Envelope verification failed: ${verification.error}`;
      this.config.onEvent?.(formatDbSyncRejected({ fromPeerId: envelope.sender, reason: error }));
      return { accepted: false, error };
    }

    // Parse snapshot
    const snapshot = parsePayload<DBSnapshot>(envelope);

    // Per-interaction attestation: verify fresh quote if provided
    if (snapshot.attestationQuote) {
      const attResult = await verifyInlineAttestation(
        snapshot.attestationQuote,
        senderPeer.ed25519PubkeyBase64,
        this.config.approvedMeasurements,
      );
      if (!attResult.valid) {
        const error = `Inline attestation failed: ${attResult.error}`;
        this.config.onEvent?.(formatDbSyncRejected({ fromPeerId: envelope.sender, reason: error }));
        return { accepted: false, error };
      }
      // Update trust store lastVerified timestamp on successful re-attestation
      senderPeer.lastVerified = Date.now();
      this.config.onEvent?.(`[INLINE_ATTEST] verified for ${envelope.sender}`);
    } else if (this.config.requireAttestation) {
      const error = 'Attestation quote required but not provided';
      this.config.onEvent?.(formatDbSyncRejected({ fromPeerId: envelope.sender, reason: error }));
      return { accepted: false, error };
    }

    // Check sequence number (must be monotonically increasing)
    if (snapshot.sequenceNum <= this.latestSequence) {
      const error = `Stale snapshot: seq ${snapshot.sequenceNum} <= ${this.latestSequence}`;
      this.config.onEvent?.(formatDbSyncRejected({ fromPeerId: envelope.sender, reason: error }));
      return { accepted: false, error };
    }

    // Optionally decrypt and verify checksum
    if (opts?.decryptAndVerify) {
      try {
        const decrypted = decrypt(this.config.vaultKey, {
          ciphertext: snapshot.encryptedDb,
          iv: snapshot.iv,
          authTag: snapshot.authTag,
        });

        const checksum = createHash('sha256').update(decrypted).digest('hex');
        if (checksum !== snapshot.checksum) {
          const error = 'Checksum mismatch after decryption';
          this.config.onEvent?.(formatDbSyncRejected({ fromPeerId: envelope.sender, reason: error }));
          return { accepted: false, error };
        }
      } catch (err) {
        const error = `Decryption failed: ${err instanceof Error ? err.message : String(err)}`;
        this.config.onEvent?.(formatDbSyncRejected({ fromPeerId: envelope.sender, reason: error }));
        return { accepted: false, error };
      }
    }

    // Accept and store
    this.latestSequence = snapshot.sequenceNum;
    this.latestEncrypted = snapshot;

    this.config.onEvent?.(formatDbSyncReceived({ fromPeerId: envelope.sender, seq: snapshot.sequenceNum }));

    return { accepted: true, sequenceNum: snapshot.sequenceNum };
  }

  /** Get the latest encrypted snapshot (for serving recovery requests). */
  getLatestSnapshot(): DBSnapshot | null {
    return this.latestEncrypted;
  }

  /** Decrypt the latest snapshot with the vault key. */
  decryptLatest(): Buffer | null {
    if (!this.latestEncrypted) return null;

    return decrypt(this.config.vaultKey, {
      ciphertext: this.latestEncrypted.encryptedDb,
      iv: this.latestEncrypted.iv,
      authTag: this.latestEncrypted.authTag,
    });
  }
}

// ── Recovery (New Agent ← Guardian) ──────────────────────────────

export interface RecoveryRequestPayload {
  /** Latest sequence number the requestor knows about. */
  latestKnownSequence: number;
  /** Fresh attestation quote for per-interaction verification (optional). */
  attestationQuote?: string;
}

export interface RecoveryResponsePayload {
  /** Encrypted DB snapshot. */
  encryptedDb: string;
  iv: string;
  authTag: string;
  sequenceNum: number;
  checksum: string;
}

/**
 * Create a signed recovery request envelope.
 */
export async function createRecoveryRequest(
  nodeId: string,
  signer: TEESigner,
  latestKnownSequence = 0,
): Promise<SignedEnvelope> {
  const payload: RecoveryRequestPayload = { latestKnownSequence };
  return createEnvelope({
    sender: nodeId,
    action: 'db.recovery.request',
    payload,
    signer,
  });
}

/**
 * Create a signed recovery response envelope with the latest snapshot.
 */
export async function createRecoveryResponse(
  nodeId: string,
  signer: TEESigner,
  snapshot: DBSnapshot,
): Promise<SignedEnvelope> {
  const payload: RecoveryResponsePayload = {
    encryptedDb: snapshot.encryptedDb,
    iv: snapshot.iv,
    authTag: snapshot.authTag,
    sequenceNum: snapshot.sequenceNum,
    checksum: snapshot.checksum,
  };
  return createEnvelope({
    sender: nodeId,
    action: 'db.recovery.response',
    payload,
    signer,
  });
}
