/**
 * Agent Registry types — shared between fund manager and guardian network.
 * The registry enforces that only ONE agent can be active at any time.
 */

/** Agent registration record stored on-chain. */
export interface AgentRecord {
  /** Unique TEE instance ID (hardware-bound, can't be copied). */
  teeInstanceId: string;
  /** Hash of the running code (verified via attestation). */
  codeHash: string;
  /** Whether this agent is currently active. */
  isActive: boolean;
  /** ISO timestamp of the last heartbeat. */
  lastHeartbeat: string;
  /** ISO timestamp of when the agent was registered. */
  registeredAt: string;
  /** Address of the proposer who submitted this registration. */
  registeredBy: string;
}

/** Registration request sent by an agent seeking approval. */
export interface RegistrationRequest {
  teeInstanceId: string;
  codeHash: string;
  attestation: string;
  endpoint: string;
  /** Agent's ed25519 public key (base64) — for trust store population. */
  ed25519PubkeyBase64?: string;
  /** Agent's X25519 public key (base64) — for ECDH vault key exchange. */
  x25519PubkeyBase64?: string;
  /** ed25519 signature over the X25519 public key (proves same TEE). */
  x25519Signature?: string;
}

/** Heartbeat payload sent every 60s by the active agent. */
export interface HeartbeatPayload {
  teeInstanceId: string;
  attestation: string;
  timestamp: number;
}

/** Result of a heartbeat check. */
export interface HeartbeatCheckResult {
  isActive: boolean;
  /** Seconds since last heartbeat. */
  secondsSinceHeartbeat: number;
  /** Whether the agent should be deactivated (>300s). */
  shouldDeactivate: boolean;
}

/** Registry client interface — abstracts the on-chain contract. */
export interface RegistryClient {
  /** Get the currently active agent, or null if none. */
  getCurrentAgent(): Promise<AgentRecord | null>;

  /** Register a new agent. Requires guardian approval (75% threshold). */
  registerAgent(request: RegistrationRequest): Promise<{ success: boolean; error?: string }>;

  /** Send a heartbeat to prove liveness. */
  heartbeat(payload: HeartbeatPayload): Promise<{ success: boolean; error?: string }>;

  /** Check if the active agent's heartbeat is fresh. */
  checkHeartbeat(): Promise<HeartbeatCheckResult | null>;

  /** Deactivate the current agent (called when heartbeat times out). */
  deactivateAgent(teeInstanceId: string): Promise<{ success: boolean; error?: string }>;

  /** Check if a specific agent is the currently registered one. */
  isRegistered(teeInstanceId: string): Promise<boolean>;
}
