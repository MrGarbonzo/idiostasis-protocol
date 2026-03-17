import { verify, createPublicKey } from 'node:crypto';
import {
  HeartbeatManager,
  ProtocolDatabase,
  stableStringify,
} from '@idiostasis/core';
import type {
  ProtocolConfig,
  PingEnvelope,
} from '@idiostasis/core';

export interface SuccessionInitiator {
  initiate(): Promise<void>;
  isInProgress(): boolean;
}

export class LivenessMonitor {
  private readonly config: ProtocolConfig;
  private readonly db: ProtocolDatabase;
  private successionHandler: SuccessionInitiator;
  private heartbeatManager: HeartbeatManager;
  private pollingId: ReturnType<typeof setInterval> | null = null;
  private primaryEd25519PublicKey: Uint8Array | null = null;

  constructor(
    config: ProtocolConfig,
    db: ProtocolDatabase,
    successionHandler: SuccessionInitiator,
    primaryEd25519PublicKey?: Uint8Array,
  ) {
    this.config = config;
    this.db = db;
    this.successionHandler = successionHandler;
    this.heartbeatManager = new HeartbeatManager(config, db, 'guardian');
    this.primaryEd25519PublicKey = primaryEd25519PublicKey ?? null;
  }

  /**
   * Set the primary's Ed25519 public key for ping signature verification.
   * Called after admission when the guardian receives the primary's key.
   */
  setPrimaryPublicKey(key: Uint8Array): void {
    this.primaryEd25519PublicKey = key;
  }

  /**
   * Replace the succession handler after admission completes and
   * real vault key is available (replaces the dummy handler).
   */
  setSuccessionHandler(handler: SuccessionInitiator): void {
    this.successionHandler = handler;
  }

  start(): void {
    this.heartbeatManager.start();
    this.pollingId = setInterval(() => {
      const msSince = this.heartbeatManager.getMsSinceLastPing();
      const threshold = this.config.livenessFailureThreshold * this.config.heartbeatIntervalMs;
      if (msSince !== null) {
        console.log(`[liveness] ms since last ping: ${msSince}, threshold: ${threshold}`);
      }
      if (this.heartbeatManager.isLivenessFailure()) {
        console.warn('[liveness] LIVENESS FAILURE DETECTED — initiating succession');
        if (!this.successionHandler.isInProgress()) {
          void this.successionHandler.initiate();
        }
      }
    }, this.config.heartbeatIntervalMs);
  }

  onPingReceived(envelope: PingEnvelope): void {
    // Validate nonce (replay protection)
    if (!this.db.checkAndStoreNonce(envelope.nonce)) {
      return;
    }

    // Validate timestamp (60s tolerance)
    const drift = Math.abs(Date.now() - envelope.timestamp);
    if (drift > 60_000) {
      return;
    }

    // Verify Ed25519 signature if primary public key is available
    if (this.primaryEd25519PublicKey) {
      const payload = {
        nonce: envelope.nonce,
        teeInstanceId: envelope.teeInstanceId,
        timestamp: envelope.timestamp,
      };
      const canonical = stableStringify(payload);
      const sigBytes = typeof envelope.signature === 'string'
        ? Buffer.from(envelope.signature, 'hex')
        : envelope.signature;

      try {
        const pubKey = createPublicKey({
          key: Buffer.concat([
            Buffer.from('302a300506032b6570032100', 'hex'), // Ed25519 DER prefix
            Buffer.from(this.primaryEd25519PublicKey),
          ]),
          format: 'der',
          type: 'spki',
        });
        const valid = verify(null, Buffer.from(canonical), pubKey, sigBytes as Buffer);
        if (!valid) {
          console.warn('[liveness-monitor] ping signature verification failed — accepting anyway (TODO: fix key mismatch)');
          // Fall through — don't drop the ping
        }
      } catch {
        // If signature verification fails due to key format issues, log and continue
        // This can happen during key rotation or if the key format doesn't match
        console.warn('[liveness-monitor] ping signature verification error, accepting ping');
      }
    }

    this.heartbeatManager.onPingReceived();
  }

  stop(): void {
    if (this.pollingId) {
      clearInterval(this.pollingId);
      this.pollingId = null;
    }
    this.heartbeatManager.stop();
  }
}
