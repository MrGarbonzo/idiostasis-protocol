/**
 * Idiostasis Protocol — Configuration Defaults
 *
 * All protocol timing parameters as exported named constants.
 * Every constant is overridable via the corresponding environment variable.
 * loadConfig() reads env vars and returns a ProtocolConfig, falling back
 * to these defaults for anything not set.
 */

import type { ProtocolConfig } from './interfaces.js';

/**
 * Interval between heartbeat pings (ms).
 * Backup agents ping the primary at this interval.
 * @env HEARTBEAT_INTERVAL_MS
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Number of consecutive missed heartbeats before declaring liveness failure.
 * At 30s interval, 10 misses = 5 minutes before succession triggers.
 * @env LIVENESS_FAILURE_THRESHOLD
 */
export const LIVENESS_FAILURE_THRESHOLD = 10;

/**
 * Hours between full re-attestation handshakes (Tier 2).
 * Primary re-attests with all guardians; guardians re-attest with backups.
 * Two consecutive failures → peer removed from trusted set (Decision 5).
 * @env RE_ATTESTATION_INTERVAL_HOURS
 */
export const RE_ATTESTATION_INTERVAL_HOURS = 6;

/**
 * Interval between encrypted DB snapshot pushes to guardians (ms).
 * Each snapshot is signed with the primary's Ed25519 key.
 * @env DB_SNAPSHOT_INTERVAL_MS
 */
export const DB_SNAPSHOT_INTERVAL_MS = 600_000;

/**
 * Time after which a peer is considered stale and eligible for pruning (ms).
 * @env PEER_STALENESS_MS
 */
export const PEER_STALENESS_MS = 1_800_000;

/**
 * Minimum number of active guardians the agent requires.
 * If external guardians drop below (minGuardianCount - 1), the agent
 * self-provisions its own guardian VM (Decision 8).
 * @env MIN_GUARDIAN_COUNT
 */
export const MIN_GUARDIAN_COUNT = 3;

/**
 * Maximum random jitter (ms) before backup agent activation during succession.
 * Prevents thundering herd when multiple backups detect primary failure (Decision 7).
 * @env BACKUP_JITTER_MAX_MS
 */
export const BACKUP_JITTER_MAX_MS = 30_000;

/**
 * Consecutive re-attestation failures before removing a peer.
 * After this many failures, peer is removed from trusted set and
 * must complete full re-admission (Decision 5).
 * @env RE_ATTEST_FAILURE_LIMIT
 */
export const RE_ATTEST_FAILURE_LIMIT = 2;

/**
 * Default PCCS endpoints for attestation quote verification (Decision 4).
 * Tried in order on failure. Hard failure only if all exhausted.
 * Additional endpoints can be added via PCCS_ENDPOINTS env var.
 */
export const DEFAULT_PCCS_ENDPOINTS: readonly string[] = [
  'https://pccs.scrtlabs.com/dcap-tools/quote-parse',
];

/**
 * Load protocol configuration from environment variables,
 * falling back to defaults for anything not set.
 *
 * String arrays (PCCS_ENDPOINTS, GUARDIAN_APPROVED_RTMR3) are
 * parsed from comma-separated env var values.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): ProtocolConfig {
  return {
    heartbeatIntervalMs: parseIntEnv(env.HEARTBEAT_INTERVAL_MS, HEARTBEAT_INTERVAL_MS),
    livenessFailureThreshold: parseIntEnv(env.LIVENESS_FAILURE_THRESHOLD, LIVENESS_FAILURE_THRESHOLD),
    reAttestationIntervalHours: parseIntEnv(env.RE_ATTESTATION_INTERVAL_HOURS, RE_ATTESTATION_INTERVAL_HOURS),
    dbSnapshotIntervalMs: parseIntEnv(env.DB_SNAPSHOT_INTERVAL_MS, DB_SNAPSHOT_INTERVAL_MS),
    peerStalenessThresholdMs: parseIntEnv(env.PEER_STALENESS_MS, PEER_STALENESS_MS),
    minGuardianCount: parseIntEnv(env.MIN_GUARDIAN_COUNT, MIN_GUARDIAN_COUNT),
    backupJitterMaxMs: parseIntEnv(env.BACKUP_JITTER_MAX_MS, BACKUP_JITTER_MAX_MS),
    reAttestFailureLimit: parseIntEnv(env.RE_ATTEST_FAILURE_LIMIT, RE_ATTEST_FAILURE_LIMIT),
    agentApprovedRtmr3: parseCommaSeparated(env.AGENT_APPROVED_RTMR3),
    guardianApprovedRtmr3: parseCommaSeparated(env.GUARDIAN_APPROVED_RTMR3),
    pccsEndpoints: parseCommaSeparatedWithDefault(env.PCCS_ENDPOINTS, [...DEFAULT_PCCS_ENDPOINTS]),
  };
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseCommaSeparated(value: string | undefined): string[] {
  if (value === undefined || value === '') return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

function parseCommaSeparatedWithDefault(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined || value === '') return fallback;
  return value.split(',').map(s => s.trim()).filter(Boolean);
}
