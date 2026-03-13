/**
 * Shared types for the Guardian Network.
 */

// ── Backup ─────────────────────────────────────────────────────

export interface Backup {
  id: number;
  timestamp: number;
  data: Buffer;
  fund_manager_id: string;
  attestation: string | null;
  size_bytes: number;
  created_at: string;
}

// ── RPC ────────────────────────────────────────────────────────

export type RpcStatus = 'active' | 'trial' | 'deprecated';

export interface RpcEntry {
  id: number;
  chain: string;
  url: string;
  added_by: string;
  status: RpcStatus;
  reputation: number;
  last_tested: string | null;
  latency_ms: number | null;
  created_at: string;
  updated_at: string;
}

export interface RpcTestResult {
  id: number;
  rpc_id: number;
  success: number;
  latency_ms: number | null;
  error: string | null;
  tested_at: string;
}

// ── Peers ──────────────────────────────────────────────────────

export interface Peer {
  address: string;
  endpoint: string;
  last_seen: string;
  is_sentry: number;
  metadata: string | null;
}

// ── Delegation ─────────────────────────────────────────────────

export interface Delegation {
  id: number;
  delegator_tg_id: string;
  sentry_address: string;
  nft_token_ids: string;  // JSON array
  total_value: number;     // cents
  signature: string;
  created_at: string;
  expires_at: string;
  is_active: number;
}

// ── Health Check ───────────────────────────────────────────────

export type HealthStatus = 'healthy' | 'warning' | 'critical' | 'unreachable';

export interface HealthCheck {
  id: number;
  status: HealthStatus;
  pool_balance: number | null;
  active_nfts: number | null;
  is_paused: number | null;
  strategy: string | null;
  details: string | null;
  checked_at: string;
}

// ── Proposals & Voting ─────────────────────────────────────────

export type ProposalType =
  | 'code_update'
  | 'rpc_add'
  | 'rpc_remove'
  | 'strategy_change'
  | 'anomaly_resolution'
  | 'agent_registration'
  | 'vault_key_rotation'
  | 'trading_limits'
  | 'emergency_pause'
  | 'emergency_unpause'
  | 'tee_measurement';

export type ProposalStatus = 'active' | 'passed' | 'failed' | 'expired';

export interface Proposal {
  id: string;
  type: ProposalType;
  proposer: string;
  description: string;
  data: string | null;
  fund_id: string | null;
  status: ProposalStatus;
  threshold_pct: number;
  deadline: string;
  created_at: string;
}

export interface Vote {
  id: number;
  proposal_id: string;
  voter_address: string;
  approve: number;
  voting_power: number;  // cents
  attestation: string | null;
  created_at: string;
}

// ── Fund Manager API Responses ─────────────────────────────────

export interface FundManagerStatus {
  total_pool_balance: number;
  total_nfts_active: number;
  active_strategy: string;
  is_paused: number;
}

export interface NFTAccountInfo {
  token_id: number;
  owner_telegram_id: string;
  current_balance: number;
  is_active: number;
}

// ── Guardian Config ────────────────────────────────────────────

export interface GuardianConfig {
  /** This guardian's address/identifier. */
  address: string;
  /** Port to listen on. */
  port: number;
  /** Fund manager endpoint. */
  fundManagerEndpoint: string;
  /** Database file path. */
  dbPath: string;
  /** Max backups to retain. */
  maxBackups: number;
}
