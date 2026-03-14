import { verify, createPublicKey } from 'node:crypto';
import type { AttestationProvider, ProtocolConfig, GuardianRecord, BackupAgentRecord } from '../interfaces.js';
import { ProtocolDatabase, ProtocolEventType } from '../database/db.js';
import { SnapshotManager } from '../database/snapshot.js';
import type { DbSnapshot } from '../database/snapshot.js';
import { KeyExchangeSession } from '../vault/exchange.js';
import type { WrappedKey } from '../vault/exchange.js';

export interface AdmissionRequest {
  role: 'guardian' | 'backup_agent';
  networkAddress: string;
  teeInstanceId: string;
  rtmr3: string;
  x25519PublicKey: Uint8Array;
  ed25519PublicKey: Uint8Array;
  ed25519Signature: Uint8Array;
  nonce: string;
  timestamp: number;
}

export interface AdmissionResult {
  accepted: boolean;
  reason?: string;
  primaryX25519PublicKey?: Uint8Array;
  primaryEd25519PublicKey?: Uint8Array;
  primaryEd25519Signature?: Uint8Array;
  vaultKey?: WrappedKey;
  dbSnapshot?: DbSnapshot;
}

const TIMESTAMP_TOLERANCE_MS = 60_000;

/** Ed25519 SPKI prefix (12 bytes) for wrapping raw 32-byte public keys. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export class AdmissionService {
  private readonly db: ProtocolDatabase;
  private readonly config: ProtocolConfig;
  private readonly vaultKey: Uint8Array;
  private readonly snapshotManager: SnapshotManager;
  private readonly signer: (data: Uint8Array) => Promise<Uint8Array>;

  constructor(
    db: ProtocolDatabase,
    config: ProtocolConfig,
    vaultKey: Uint8Array,
    snapshotManager: SnapshotManager,
    signer: (data: Uint8Array) => Promise<Uint8Array>,
  ) {
    this.db = db;
    this.config = config;
    this.vaultKey = vaultKey;
    this.snapshotManager = snapshotManager;
    this.signer = signer;
  }

  async handleAdmissionRequest(req: AdmissionRequest): Promise<AdmissionResult> {
    // 1. Check nonce
    if (!this.db.checkAndStoreNonce(req.nonce)) {
      return { accepted: false, reason: 'replay' };
    }

    // 2. Verify timestamp is within 60 seconds
    const drift = Math.abs(Date.now() - req.timestamp);
    if (drift > TIMESTAMP_TOLERANCE_MS) {
      return { accepted: false, reason: 'stale_timestamp' };
    }

    // 3. Verify ed25519 signature over x25519PublicKey
    if (!verifyEd25519Signature(req.x25519PublicKey, req.ed25519Signature, req.ed25519PublicKey)) {
      return { accepted: false, reason: 'invalid_signature' };
    }

    // 4. Verify RTMR3 based on role
    if (req.role === 'guardian') {
      if (!this.config.guardianApprovedRtmr3.includes(req.rtmr3)) {
        return { accepted: false, reason: 'rtmr3_mismatch' };
      }
    } else {
      // backup_agent: must match agent RTMR3 (same codebase as primary)
      const agentRtmr3 = this.db.getConfig('agent_rtmr3');
      const approvedList = agentRtmr3
        ? [agentRtmr3, ...this.config.agentApprovedRtmr3]
        : this.config.agentApprovedRtmr3;
      if (!approvedList.includes(req.rtmr3)) {
        return { accepted: false, reason: 'rtmr3_mismatch' };
      }
    }

    // 5. Key exchange
    const session = await KeyExchangeSession.generate();
    const sharedSecret = session.computeSharedSecret(req.x25519PublicKey);
    const primaryKeys = session.getPublicKeys();

    // 6. Write to DB
    const now = new Date();
    if (req.role === 'guardian') {
      const record: GuardianRecord = {
        id: req.teeInstanceId,
        networkAddress: req.networkAddress,
        teeInstanceId: req.teeInstanceId,
        rtmr3: req.rtmr3,
        admittedAt: now,
        lastAttestedAt: now,
        lastSeenAt: now,
        status: 'active',
        provisionedBy: 'external',
        agentVmId: null,
      };
      this.db.upsertGuardian(record);
      this.db.logEvent(ProtocolEventType.ADMISSION, `guardian:${req.teeInstanceId}`);

      // 7. Guardian response: vault key + snapshot
      const wrappedVaultKey = session.wrapVaultKey(this.vaultKey, sharedSecret);
      const snapshot = await this.snapshotManager.createSnapshot(this.signer);

      return {
        accepted: true,
        primaryX25519PublicKey: primaryKeys.x25519,
        primaryEd25519PublicKey: primaryKeys.ed25519,
        primaryEd25519Signature: primaryKeys.signature,
        vaultKey: wrappedVaultKey,
        dbSnapshot: snapshot,
      };
    } else {
      // backup_agent
      const record: BackupAgentRecord = {
        id: req.teeInstanceId,
        networkAddress: req.networkAddress,
        teeInstanceId: req.teeInstanceId,
        rtmr3: req.rtmr3,
        registeredAt: now,
        heartbeatStreak: 0,
        lastHeartbeatAt: now,
        status: 'standby',
      };
      this.db.upsertBackupAgent(record);
      this.db.logEvent(ProtocolEventType.ADMISSION, `backup:${req.teeInstanceId}`);

      // 7. Backup response: no vault key (spec Section 6)
      return {
        accepted: true,
        primaryX25519PublicKey: primaryKeys.x25519,
        primaryEd25519PublicKey: primaryKeys.ed25519,
        primaryEd25519Signature: primaryKeys.signature,
      };
    }
  }
}

function verifyEd25519Signature(
  data: Uint8Array,
  signature: Uint8Array,
  publicKeyRaw: Uint8Array,
): boolean {
  try {
    const spki = Buffer.concat([ED25519_SPKI_PREFIX, publicKeyRaw]);
    const pubKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return verify(null, data, pubKey, signature);
  } catch {
    return false;
  }
}
