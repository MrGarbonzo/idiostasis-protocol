/**
 * Recovery Provider — serve verified database snapshots to authorized requestors.
 * Used when a new agent or backup agent needs the latest fund manager DB.
 *
 * Supports two modes:
 * - Legacy mode: plain HTTP with basic validation (backwards compatible)
 * - Signed mode: SignedEnvelope with attestation verification via trust store
 */
import type Database from 'better-sqlite3';
import { BackupStorage } from './storage.js';
import type { TEESigner } from '../shared/tee-signer.js';
import type { TrustStore } from '../shared/trust-store.js';
import { verifyEnvelope, parsePayload, type SignedEnvelope } from '../shared/signed-envelope.js';
import {
  createRecoveryResponse,
  type RecoveryRequestPayload,
  type DBSnapshot,
} from './db-sync.js';
import { verifyInlineAttestation } from '../shared/attestation-verifier.js';
import { formatRecoveryRequest, formatRecoveryServed } from '../shared/telegram-protocol.js';

export interface RecoveryRequest {
  /** Requesting agent's TEE instance ID. */
  agentId: string;
  /** Attestation proving the agent is registered. */
  attestation: string;
}

export interface RecoveryResponse {
  success: boolean;
  backup?: {
    id: number;
    timestamp: number;
    data: Buffer;
    sizeBytes: number;
    fundManagerId: string;
  };
  error?: string;
}

export interface SignedRecoveryDeps {
  signer: TEESigner;
  trustStore: TrustStore;
  nodeId: string;
  /** Latest encrypted snapshot from DBSnapshotReceiver, if available. */
  getLatestSnapshot?: () => DBSnapshot | null;
  /** Optional callback for trust events. */
  onEvent?: (msg: string) => void;
  /** Approved code measurement hashes for inline attestation (empty = accept all). */
  approvedMeasurements?: Set<string>;
}

export class RecoveryProvider {
  private storage: BackupStorage;
  private signedDeps?: SignedRecoveryDeps;

  constructor(db: Database.Database, maxBackups = 1000, signedDeps?: SignedRecoveryDeps) {
    this.storage = new BackupStorage(db, maxBackups);
    this.signedDeps = signedDeps;
  }

  /**
   * Handle a legacy (unsigned) recovery request.
   * Kept for backwards compatibility during migration.
   */
  async handleRecovery(request: RecoveryRequest): Promise<RecoveryResponse> {
    // Basic validation
    if (!request.agentId || !request.attestation) {
      return { success: false, error: 'Missing agentId or attestation' };
    }

    const latest = this.storage.getLatest();
    if (!latest) {
      return { success: false, error: 'No backups available' };
    }

    return {
      success: true,
      backup: {
        id: latest.id,
        timestamp: latest.timestamp,
        data: latest.data,
        sizeBytes: latest.size_bytes,
        fundManagerId: latest.fund_manager_id,
      },
    };
  }

  /**
   * Handle a signed recovery request.
   * Verifies the envelope against the trust store, then returns the latest
   * encrypted snapshot wrapped in a signed response envelope.
   */
  async handleSignedRecovery(
    envelope: SignedEnvelope,
  ): Promise<{ success: boolean; responseEnvelope?: SignedEnvelope; error?: string }> {
    if (!this.signedDeps) {
      return { success: false, error: 'Signed recovery not configured' };
    }

    const { signer, trustStore, nodeId, getLatestSnapshot, onEvent } = this.signedDeps;

    onEvent?.(formatRecoveryRequest({ fromPeerId: envelope.sender }));

    // Verify sender is attested
    const senderPeer = trustStore.getPeer(envelope.sender);
    if (!senderPeer) {
      return { success: false, error: `Sender not attested: ${envelope.sender}` };
    }

    // Verify envelope
    const verification = verifyEnvelope({
      envelope,
      senderPubkeyBase64: senderPeer.ed25519PubkeyBase64,
      signer,
      nonceTracker: trustStore.getNonceTracker(),
    });

    if (!verification.valid) {
      return { success: false, error: `Envelope verification failed: ${verification.error}` };
    }

    // Per-interaction attestation: verify fresh quote if provided
    const reqPayload = parsePayload<RecoveryRequestPayload>(envelope);
    if (reqPayload.attestationQuote) {
      const attResult = await verifyInlineAttestation(
        reqPayload.attestationQuote,
        senderPeer.ed25519PubkeyBase64,
        this.signedDeps.approvedMeasurements,
      );
      if (!attResult.valid) {
        return { success: false, error: `Inline attestation failed: ${attResult.error}` };
      }
      senderPeer.lastVerified = Date.now();
      onEvent?.(`[INLINE_ATTEST] recovery verified for ${envelope.sender}`);
    }

    // Get latest snapshot
    const snapshot = getLatestSnapshot?.();
    if (!snapshot) {
      // Fall back to storage
      const latest = this.storage.getLatest();
      if (!latest) {
        return { success: false, error: 'No backups available' };
      }
      // Legacy backup doesn't have vault-key encryption, so we can't serve it
      // via the signed protocol. The caller should use the legacy endpoint.
      return { success: false, error: 'No encrypted snapshots available; use legacy recovery' };
    }

    // Create signed response
    const responseEnvelope = await createRecoveryResponse(nodeId, signer, snapshot);
    onEvent?.(formatRecoveryServed({ toPeerId: envelope.sender, seq: snapshot.sequenceNum }));
    return { success: true, responseEnvelope };
  }

  /** Get storage stats for monitoring. */
  getStorageStats(): { backupCount: number; totalSizeBytes: number; latestTimestamp: number | null } {
    const latest = this.storage.getLatest();
    return {
      backupCount: this.storage.count(),
      totalSizeBytes: this.storage.totalSizeBytes(),
      latestTimestamp: latest?.timestamp ?? null,
    };
  }
}
