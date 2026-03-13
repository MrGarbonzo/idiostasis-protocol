/**
 * Heartbeat System — prove liveness to the guardian registry every 60s.
 *
 * Each heartbeat sends a fresh attestation with the current TEE instance ID.
 * If the heartbeat fails repeatedly, the agent should self-deactivate
 * to allow a backup to take over.
 *
 * Supports both legacy (HMAC) and signed (ed25519 envelope) modes.
 */
import type { TEEIdentity } from './tee.js';
import { generateAttestation, serializeAttestation } from './attestation-utils.js';
import type { TEESigner } from './tee-signing.js';
import { createEnvelope } from './tee-signing.js';

/** Heartbeat interval in milliseconds (60 seconds). */
const HEARTBEAT_INTERVAL_MS = 60_000;

/** Max consecutive failures before self-deactivation. */
const MAX_CONSECUTIVE_FAILURES = 5;

export interface HeartbeatConfig {
  /** Guardian endpoint managing the registry. */
  guardianEndpoint: string;
  /** TEE identity of this agent. */
  teeIdentity: TEEIdentity;
  /** Callback when heartbeat fails repeatedly — agent should shut down. */
  onDeactivation: (reason: string) => void;
  /** Optional callback for each heartbeat result. */
  onHeartbeat?: (success: boolean, consecutiveFailures: number) => void;
  /** If provided, heartbeats are wrapped in signed envelopes. */
  signer?: TEESigner;
}

export interface HeartbeatManager {
  /** Start sending heartbeats. */
  start(): void;
  /** Stop sending heartbeats. */
  stop(): void;
  /** Get current status. */
  status(): { running: boolean; consecutiveFailures: number; lastSuccess: number | null };
}

/**
 * Create and return a heartbeat manager.
 * Call .start() after successful registration.
 */
export function createHeartbeatManager(config: HeartbeatConfig): HeartbeatManager {
  const endpoint = config.guardianEndpoint.replace(/\/$/, '');
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let consecutiveFailures = 0;
  let lastSuccess: number | null = null;

  async function sendHeartbeat(): Promise<void> {
    try {
      const attestation = generateAttestation(
        config.teeIdentity.instanceId,
        config.teeIdentity.codeHash,
      );

      const heartbeatPayload = {
        teeInstanceId: config.teeIdentity.instanceId,
        attestation: serializeAttestation(attestation),
        timestamp: Date.now(),
      };

      // If signer available, wrap in signed envelope
      let body: string;
      if (config.signer) {
        const envelope = await createEnvelope(
          config.teeIdentity.instanceId,
          'heartbeat',
          heartbeatPayload,
          config.signer,
        );
        body = JSON.stringify(envelope);
      } else {
        body = JSON.stringify(heartbeatPayload);
      }

      const res = await fetch(`${endpoint}/api/sentry/agent/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(10_000),
      });

      const result = (await res.json()) as { success: boolean; error?: string };

      if (result.success) {
        consecutiveFailures = 0;
        lastSuccess = Date.now();
        config.onHeartbeat?.(true, 0);
      } else {
        consecutiveFailures++;
        console.warn(`[Heartbeat] Failed: ${result.error} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
        config.onHeartbeat?.(false, consecutiveFailures);
      }
    } catch (err) {
      consecutiveFailures++;
      console.warn(
        `[Heartbeat] Error: ${err instanceof Error ? err.message : err} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
      );
      config.onHeartbeat?.(false, consecutiveFailures);
    }

    // Check if we should deactivate
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.error(`[Heartbeat] ${MAX_CONSECUTIVE_FAILURES} consecutive failures — deactivating`);
      stop();
      config.onDeactivation(
        `${MAX_CONSECUTIVE_FAILURES} consecutive heartbeat failures`,
      );
    }
  }

  function start(): void {
    if (intervalId) return; // Already running
    console.log(`[Heartbeat] Starting (every ${HEARTBEAT_INTERVAL_MS / 1000}s)`);
    // Send first heartbeat immediately
    sendHeartbeat();
    intervalId = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  }

  function stop(): void {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
      console.log('[Heartbeat] Stopped');
    }
  }

  function status() {
    return {
      running: intervalId !== null,
      consecutiveFailures,
      lastSuccess,
    };
  }

  return { start, stop, status };
}
