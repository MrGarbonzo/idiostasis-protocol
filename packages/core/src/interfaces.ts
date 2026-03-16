/**
 * Idiostasis Protocol — Core Interface Definitions
 *
 * This file is the contract everything else builds against.
 * All types here are protocol-level. No application-specific logic.
 */

/**
 * Implement this to plug application state into the protocol.
 * The protocol encrypts and replicates whatever this returns.
 * It knows nothing about what the state contains.
 */
export interface AgentStateAdapter {
  /** Serialize application state to bytes for DB storage */
  serialize(): Promise<Uint8Array>;

  /** Restore application state from bytes after succession */
  deserialize(data: Uint8Array): Promise<void>;

  /** Called once succession is complete and agent is primary */
  onSuccessionComplete(): Promise<void>;

  /** Called to verify state integrity (optional, for guardian cross-reference) */
  verify?(): Promise<boolean>;
}

/**
 * Implement this to add application-specific health checks.
 * Guardian calls this after each liveness ping.
 * Protocol only cares about the boolean result.
 */
export interface HealthCheckAdapter {
  check(): Promise<HealthCheckResult>;
}

/** Result of an application-specific health check. */
export interface HealthCheckResult {
  /** Whether the application considers itself healthy */
  healthy: boolean;
  /** Severity level for logging/alerting */
  severity: 'ok' | 'warning' | 'critical';
  /** Human-readable reason, included in logs when not healthy */
  reason?: string;
}

/**
 * Implement this to swap attestation providers.
 * Default implementation uses SecretLabs PCCS.
 * Swapping to Intel DCAP or any other provider requires
 * only a new implementation of this interface.
 */
export interface AttestationProvider {
  /**
   * Fetch TDX quote from cpu.html endpoint.
   * Must use multi-strategy HTML extraction (Decision 4):
   * 1. <pre> tag content
   * 2. <textarea> tag content
   * 3. Longest hex string >= 128 chars
   * 4. Longest base64 string >= 128 chars
   * Log which strategy succeeded.
   */
  fetchQuote(domain: string): Promise<string>;

  /**
   * Verify quote against PCCS, return RTMR3.
   * Must check both `rtmr3` and `rtmr_3` field names in response.
   * Must use per-request TLS agent (never global NODE_TLS_REJECT_UNAUTHORIZED).
   * Tries endpoints in order; hard failure only if all exhausted.
   */
  verifyQuote(quote: string): Promise<AttestationResult>;

  /**
   * Fetch structured attestation report from self.html endpoint.
   * Returns parsed fields including RTMR3 directly.
   * More reliable than parsing cpu.html when available.
   * Optional — implementations may not support it.
   */
  fetchSelfReport?(domain: string): Promise<SelfReport>;
}

/** Structured attestation report parsed from self.html endpoint. */
export interface SelfReport {
  rtmr0?: string;
  rtmr1?: string;
  rtmr2?: string;
  rtmr3?: string;
  reportData?: string;
  mrtd?: string;
  raw?: string;
}

/** Result of a PCCS attestation quote verification. */
export interface AttestationResult {
  /** RTMR3 container image measurement from the quote */
  rtmr3: string;
  /** Whether the quote passed PCCS verification */
  valid: boolean;
  /** TCB status string from PCCS (e.g. 'UpToDate', 'OutOfDate', 'unknown') */
  tcbStatus: string;
}

/**
 * Protocol configuration. All timing parameters are configurable
 * via environment variables with sensible defaults.
 * Defaults are defined in config.ts and loaded via loadConfig().
 */
export interface ProtocolConfig {
  /**
   * Interval between heartbeat pings from backup agents to primary.
   * @default 30_000 (30 seconds)
   * @env HEARTBEAT_INTERVAL_MS
   */
  heartbeatIntervalMs: number;

  /**
   * Number of consecutive missed heartbeats before declaring liveness failure.
   * At default heartbeat interval (30s), 10 misses = 5 minutes.
   * @default 10
   * @env LIVENESS_FAILURE_THRESHOLD
   */
  livenessFailureThreshold: number;

  /**
   * Hours between full re-attestation handshakes (Tier 2 verification).
   * Each cycle: primary re-attests with all guardians, guardians re-attest
   * with all known backup agents. Two consecutive failures remove peer.
   * @default 6
   * @env RE_ATTESTATION_INTERVAL_HOURS
   */
  reAttestationIntervalHours: number;

  /**
   * Interval between encrypted DB snapshot pushes to guardians.
   * Each push is signed with primary's Ed25519 key (Tier 1 verification).
   * @default 600_000 (10 minutes)
   * @env DB_SNAPSHOT_INTERVAL_MS
   */
  dbSnapshotIntervalMs: number;

  /**
   * Time after which a peer is considered stale and pruned.
   * @default 1_800_000 (30 minutes)
   * @env PEER_STALENESS_MS
   */
  peerStalenessThresholdMs: number;

  /**
   * Minimum number of active guardians before the agent will
   * self-provision its own guardian VM (Decision 8).
   * @default 3
   * @env MIN_GUARDIAN_COUNT
   */
  minGuardianCount: number;

  /**
   * Maximum random jitter (ms) added before backup agent activation
   * to prevent thundering herd during succession (Decision 7).
   * @default 30_000 (30 seconds)
   * @env BACKUP_JITTER_MAX_MS
   */
  backupJitterMaxMs: number;

  /**
   * Consecutive re-attestation failures before removing a peer
   * from trusted set and requiring full re-admission (Decision 5).
   * @default 2
   * @env RE_ATTEST_FAILURE_LIMIT
   */
  reAttestFailureLimit: number;

  /**
   * Approved RTMR3 measurements for agent code.
   * Set at initialization from own /dev/attestation/rtmr3 (Decision 2).
   * Stored in protocol DB config table. Immutable after first boot.
   */
  agentApprovedRtmr3: string[];

  /**
   * Approved RTMR3 measurements for guardian code.
   * Set via GUARDIAN_APPROVED_RTMR3 env var at deploy time (Decision 2).
   * Guardian-side concern; agent never reads this from outside.
   */
  guardianApprovedRtmr3: string[];

  /**
   * PCCS verification endpoints, tried in order on failure.
   * Hard failure only if all endpoints are exhausted (Decision 4).
   * @default ['https://pccs.scrtlabs.com/dcap-tools/quote-parse']
   * @env PCCS_ENDPOINTS (comma-separated)
   */
  pccsEndpoints: string[];
}

/**
 * A registered guardian node in the protocol database.
 * Guardians store encrypted DB snapshots and participate in succession.
 */
export interface GuardianRecord {
  /** Unique identifier for this guardian */
  id: string;
  /** Network address (host:port) for protocol communication */
  networkAddress: string;
  /** TEE instance ID — stable across code updates for a given VM */
  teeInstanceId: string;
  /** RTMR3 container image measurement at admission */
  rtmr3: string;
  /** When this guardian was admitted to the network */
  admittedAt: Date;
  /** Last successful full re-attestation (Tier 2) */
  lastAttestedAt: Date;
  /** Last seen (heartbeat or any valid protocol message) */
  lastSeenAt: Date;
  /** Current status in the protocol */
  status: 'active' | 'pending_re_attestation' | 'inactive';
  /**
   * Who provisioned this guardian VM (Decision 8).
   * 'agent' = self-provisioned by the primary agent.
   * 'external' = independently operated by a third party.
   */
  provisionedBy: 'agent' | 'external';
  /**
   * SecretVM VM ID, only populated when provisionedBy='agent'.
   * Used by the agent to restart or recreate its own guardian.
   */
  agentVmId: string | null;
}

/**
 * A registered backup agent in the protocol database.
 * Backup agents are candidates for succession on primary failure.
 *
 * Tiebreaker order for succession selection (Decision 7):
 * 1. Highest heartbeatStreak
 * 2. Earliest registeredAt (longer-standing backup wins)
 * 3. Lexicographically lowest teeInstanceId (deterministic final tiebreaker)
 */
export interface BackupAgentRecord {
  /** Unique identifier for this backup agent */
  id: string;
  /** Network address (host:port) for protocol communication */
  networkAddress: string;
  /** TEE instance ID — stable across code updates for a given VM */
  teeInstanceId: string;
  /** RTMR3 container image measurement at registration */
  rtmr3: string;
  /** When this backup agent was registered — used in tiebreaker */
  registeredAt: Date;
  /** Consecutive successful heartbeats — primary tiebreaker for succession */
  heartbeatStreak: number;
  /** Last successful heartbeat from this backup */
  lastHeartbeatAt: Date;
  /** Current status */
  status: 'standby' | 'inactive';
}

/**
 * Optional pre- and post-deploy hooks for application-specific
 * steps during the boot sequence. Injected into the boot agent.
 */
export interface BootHook {
  /**
   * Called before the primary agent VM is created.
   * Use for application-specific pre-deploy validation or setup.
   */
  preDeploy?(): Promise<void>;

  /**
   * Called after the primary agent VM is created, attested, and funded.
   * Use for application-specific post-deploy initialization.
   */
  postDeploy?(agentEndpoint: string): Promise<void>;
}
