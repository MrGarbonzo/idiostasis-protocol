import { randomBytes } from 'node:crypto';
import type { ProtocolConfig } from '../interfaces.js';
import { ProtocolDatabase, ProtocolEventType } from '../database/db.js';
import { stableStringify } from '../utils.js';

export interface PingEnvelope {
  teeInstanceId: string;
  timestamp: number;
  nonce: string;
  signature: string;
}

/**
 * Transport function for sending pings. Injectable for testing.
 * Returns true if the ping was acknowledged, false on failure.
 */
export type PingTransport = (
  networkAddress: string,
  envelope: PingEnvelope,
) => Promise<boolean>;

/**
 * Signer function for ping envelopes.
 * Signs the canonical JSON of { teeInstanceId, timestamp, nonce }.
 */
export type PingSigner = (data: Uint8Array) => Promise<Uint8Array>;

export class HeartbeatManager {
  private readonly config: ProtocolConfig;
  private readonly db: ProtocolDatabase;
  private readonly role: 'primary' | 'guardian';
  private intervalId: ReturnType<typeof setInterval> | null = null;

  // Primary-only fields
  private transport: PingTransport | null = null;
  private signer: PingSigner | null = null;
  private teeInstanceId: string | null = null;

  // Guardian-only fields
  private lastPingAt: number | null = null;

  constructor(config: ProtocolConfig, db: ProtocolDatabase, role: 'primary' | 'guardian') {
    this.config = config;
    this.db = db;
    this.role = role;
  }

  /**
   * Start the heartbeat loop.
   * Primary: requires transport, signer, and teeInstanceId to send pings.
   * Guardian: just starts tracking received pings.
   */
  start(opts?: {
    transport?: PingTransport;
    signer?: PingSigner;
    teeInstanceId?: string;
  }): void {
    if (this.intervalId) return;

    if (this.role === 'primary') {
      if (!opts?.transport || !opts?.signer || !opts?.teeInstanceId) {
        throw new Error('Primary heartbeat requires transport, signer, and teeInstanceId');
      }
      this.transport = opts.transport;
      this.signer = opts.signer;
      this.teeInstanceId = opts.teeInstanceId;

      this.intervalId = setInterval(() => {
        void this.pingAll();
      }, this.config.heartbeatIntervalMs);

      // Fire immediately on start
      void this.pingAll();
    } else {
      // Guardian: nothing to do on start — onPingReceived is called by HTTP server
      this.intervalId = setInterval(() => {}, this.config.heartbeatIntervalMs);
    }
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Guardian: called by HTTP server when a valid ping is received from primary. */
  onPingReceived(): void {
    this.lastPingAt = Date.now();
  }

  /**
   * Guardian: returns true if primary has missed enough consecutive heartbeats.
   * Returns false if no ping has ever been received (not started yet, not a failure).
   */
  isLivenessFailure(): boolean {
    if (this.lastPingAt === null) return false;
    const elapsed = Date.now() - this.lastPingAt;
    return elapsed > this.config.livenessFailureThreshold * this.config.heartbeatIntervalMs;
  }

  /** Guardian: returns ms since last ping, or null if none received. */
  getMsSinceLastPing(): number | null {
    if (this.lastPingAt === null) return null;
    return Date.now() - this.lastPingAt;
  }

  private async pingAll(): Promise<void> {
    const backups = this.db.listBackupAgents('standby');
    const guardians = this.db.listGuardians('active');

    const participants = [
      ...backups.map(b => ({ id: b.id, address: b.networkAddress, type: 'backup' as const })),
      ...guardians.map(g => ({ id: g.id, address: g.networkAddress, type: 'guardian' as const })),
    ];

    // All pings fire in parallel
    const results = await Promise.allSettled(
      participants.map(async (p) => {
        const envelope = await this.createEnvelope();
        const success = await this.transport!(p.address, envelope);
        return { ...p, success };
      }),
    );

    for (const result of results) {
      if (result.status === 'rejected') continue;
      const { id, success, type } = result.value;

      if (type === 'backup') {
        if (success) {
          this.db.incrementStreak(id);
        } else {
          this.db.resetStreak(id);
          this.db.logEvent(ProtocolEventType.HEARTBEAT_RESET, id);
        }
      }
    }
  }

  private async createEnvelope(): Promise<PingEnvelope> {
    const payload = {
      nonce: randomBytes(16).toString('hex'),
      teeInstanceId: this.teeInstanceId!,
      timestamp: Date.now(),
    };
    const canonical = stableStringify(payload);
    const signatureBytes = await this.signer!(new Uint8Array(Buffer.from(canonical)));
    return {
      teeInstanceId: payload.teeInstanceId,
      timestamp: payload.timestamp,
      nonce: payload.nonce,
      signature: Buffer.from(signatureBytes).toString('base64'),
    };
  }
}
