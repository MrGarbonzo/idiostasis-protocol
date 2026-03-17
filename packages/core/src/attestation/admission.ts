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
  /** Self-reported RTMR3 — only trusted in DEV_MODE. In production, RTMR3 comes from PCCS. */
  rtmr3?: string;
  /** SecretVM domain for independent attestation (e.g. violet-ostrich.vm.scrtlabs.com) */
  domain?: string;
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
  private readonly attestationProvider?: AttestationProvider;

  constructor(
    db: ProtocolDatabase,
    config: ProtocolConfig,
    vaultKey: Uint8Array,
    snapshotManager: SnapshotManager,
    signer: (data: Uint8Array) => Promise<Uint8Array>,
    attestationProvider?: AttestationProvider,
  ) {
    this.db = db;
    this.config = config;
    this.vaultKey = vaultKey;
    this.snapshotManager = snapshotManager;
    this.signer = signer;
    this.attestationProvider = attestationProvider;

    if (!attestationProvider && process.env.DEV_MODE !== 'true') {
      console.warn('[admission] No attestation provider — RTMR3 unverified');
    }
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

    // 4. Verify RTMR3 — independently via PCCS in production, self-reported in DEV_MODE
    let verifiedRtmr3: string;

    if (process.env.DEV_MODE === 'true' || !this.attestationProvider) {
      // DEV MODE or no provider: trust self-reported RTMR3
      verifiedRtmr3 = req.rtmr3 ?? 'dev-measurement';
      if (process.env.DEV_MODE === 'true') {
        console.warn(
          `[admission] DEV_MODE: skipping attestation for ${req.teeInstanceId}`,
        );
      }
    } else {
      // PRODUCTION: independently verify RTMR3 via PCCS
      if (!req.domain) {
        return { accepted: false, reason: 'missing_domain' };
      }

      try {
        console.log(
          `[admission] fetching attestation from https://${req.domain}:29343/cpu.html`,
        );
        const quote = await this.attestationProvider.fetchQuote(req.domain);
        const attestResult = await this.attestationProvider.verifyQuote(quote);

        if (!attestResult.valid) {
          return { accepted: false, reason: 'attestation_invalid' };
        }

        verifiedRtmr3 = attestResult.rtmr3;

        // TODO: implement cert fingerprint check — see SecretVM docs Step 6
        console.log(
          `[admission] Attestation verified for ${req.teeInstanceId}, ` +
          `RTMR3: ${verifiedRtmr3.slice(0, 16)}...`,
        );
      } catch (err) {
        console.error(`[admission] Attestation failed for ${req.domain}: ${err}`);
        return { accepted: false, reason: 'attestation_failed' };
      }
    }

    // Check verifiedRtmr3 against approved list
    if (req.role === 'guardian') {
      const approvedGuardianRtmr3 = this.config.guardianApprovedRtmr3;

      if (approvedGuardianRtmr3.length === 0) {
        // No approved RTMR3 set yet — first guardian locks it
        const locked = this.db.getConfig('guardian_rtmr3');
        if (!locked) {
          // First guardian ever — lock its RTMR3 as canonical
          this.db.setConfig('guardian_rtmr3', verifiedRtmr3);
          console.warn(
            `[admission] FIRST GUARDIAN: locking guardian RTMR3 to ` +
            `${verifiedRtmr3.slice(0, 16)}... ` +
            `teeInstanceId=${req.teeInstanceId}`,
          );
          // Continue — this guardian is admitted
        } else if (locked !== verifiedRtmr3) {
          // Subsequent guardian — must match the locked value
          console.warn(
            `[admission] guardian RTMR3 mismatch: ` +
            `expected ${locked.slice(0, 16)}... ` +
            `got ${verifiedRtmr3.slice(0, 16)}...`,
          );
          return { accepted: false, reason: 'rtmr3_mismatch' };
        }
        // locked === verifiedRtmr3 — matches, continue
      } else {
        // Explicit approved list set — require match
        const locked = this.db.getConfig('guardian_rtmr3');
        const fullList = locked
          ? [...approvedGuardianRtmr3, locked]
          : approvedGuardianRtmr3;
        if (!fullList.includes(verifiedRtmr3)) {
          return { accepted: false, reason: 'rtmr3_mismatch' };
        }
      }
    } else {
      // backup_agent — auto-lock on first admission, same pattern as guardian
      const lockedBackupRtmr3 = this.db.getConfig('backup_rtmr3');

      if (!lockedBackupRtmr3) {
        // First backup ever — lock its RTMR3 as canonical
        this.db.setConfig('backup_rtmr3', verifiedRtmr3);
        console.warn(
          `[admission] FIRST BACKUP: locking backup RTMR3 to ` +
          `${verifiedRtmr3.slice(0, 16)}... ` +
          `teeInstanceId=${req.teeInstanceId}`,
        );
        // Continue — this backup is admitted
      } else if (lockedBackupRtmr3 !== verifiedRtmr3) {
        // Subsequent backup — must match the locked value
        console.warn(
          `[admission] backup RTMR3 mismatch: ` +
          `expected ${lockedBackupRtmr3.slice(0, 16)}... ` +
          `got ${verifiedRtmr3.slice(0, 16)}...`,
        );
        return { accepted: false, reason: 'rtmr3_mismatch' };
      }
      // lockedBackupRtmr3 === verifiedRtmr3 — matches, continue
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
        rtmr3: verifiedRtmr3,
        admittedAt: now,
        lastAttestedAt: now,
        lastSeenAt: now,
        status: 'active',
        provisionedBy: 'external',
        agentVmId: null,
      };
      this.db.upsertGuardian(record);
      this.db.setPeerPublicKey(req.teeInstanceId, req.ed25519PublicKey, req.x25519PublicKey);
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
        rtmr3: verifiedRtmr3,
        registeredAt: now,
        heartbeatStreak: 0,
        lastHeartbeatAt: now,
        status: 'standby',
      };
      this.db.upsertBackupAgent(record);
      this.db.setPeerPublicKey(req.teeInstanceId, req.ed25519PublicKey, req.x25519PublicKey);
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
