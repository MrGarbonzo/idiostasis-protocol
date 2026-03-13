-- Panthers Guardian Network — Database Schema

-- ── Backup Storage ─────────────────────────────────────────────
-- Fund manager sends hourly DB snapshots via attested channel.
-- Keep last 1000 backups (~41 days at hourly).

CREATE TABLE IF NOT EXISTS backups (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp           INTEGER NOT NULL,
  data                BLOB NOT NULL,
  fund_manager_id     TEXT NOT NULL,
  attestation         TEXT,
  size_bytes          INTEGER NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_backups_timestamp ON backups(timestamp);

-- ── RPC Registry ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rpc_registry (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chain       TEXT NOT NULL,
  url         TEXT NOT NULL UNIQUE,
  added_by    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'trial' CHECK (status IN ('active', 'trial', 'deprecated')),
  reputation  INTEGER NOT NULL DEFAULT 0,
  last_tested TEXT,
  latency_ms  INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rpc_chain ON rpc_registry(chain);
CREATE INDEX IF NOT EXISTS idx_rpc_status ON rpc_registry(status);

-- ── RPC Test Results ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rpc_test_results (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rpc_id      INTEGER NOT NULL REFERENCES rpc_registry(id),
  success     INTEGER NOT NULL CHECK (success IN (0, 1)),
  latency_ms  INTEGER,
  error       TEXT,
  tested_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rpc_tests_rpc ON rpc_test_results(rpc_id);

-- ── Peer Registry ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS peers (
  address     TEXT PRIMARY KEY,
  endpoint    TEXT NOT NULL,
  last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
  is_sentry   INTEGER NOT NULL DEFAULT 0 CHECK (is_sentry IN (0, 1)),
  metadata    TEXT
);

-- ── Delegations ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS delegations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  delegator_tg_id TEXT NOT NULL,
  sentry_address  TEXT NOT NULL,
  nft_token_ids   TEXT NOT NULL,          -- JSON array of token IDs
  total_value     INTEGER NOT NULL DEFAULT 0,  -- Sum of current_balance (cents)
  signature       TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT NOT NULL,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_delegations_sentry ON delegations(sentry_address);
CREATE INDEX IF NOT EXISTS idx_delegations_active ON delegations(is_active);

-- ── NFT Stakes ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS nft_stakes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  guardian_address TEXT NOT NULL,
  owner_tg_id     TEXT NOT NULL,
  token_id        INTEGER NOT NULL,
  current_value   INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  last_verified   TEXT NOT NULL DEFAULT (datetime('now')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  staked_at       TEXT NOT NULL DEFAULT (datetime('now')),
  unstaked_at     TEXT,
  UNIQUE(guardian_address, token_id)
);

CREATE INDEX IF NOT EXISTS idx_nft_stakes_guardian ON nft_stakes(guardian_address);
CREATE INDEX IF NOT EXISTS idx_nft_stakes_active ON nft_stakes(is_active);

-- ── Fund Health Checks ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS health_checks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  status          TEXT NOT NULL CHECK (status IN ('healthy', 'warning', 'critical', 'unreachable')),
  pool_balance    INTEGER,
  active_nfts     INTEGER,
  is_paused       INTEGER,
  strategy        TEXT,
  details         TEXT,
  checked_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_health_time ON health_checks(checked_at);

-- ── Proposals ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS proposals (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL CHECK (type IN ('code_update', 'rpc_add', 'rpc_remove', 'strategy_change', 'anomaly_resolution', 'agent_registration', 'vault_key_rotation', 'trading_limits', 'emergency_pause', 'emergency_unpause', 'tee_measurement')),
  proposer        TEXT NOT NULL,
  description     TEXT NOT NULL,
  data            TEXT,                   -- JSON blob with proposal-specific data
  fund_id         TEXT,                   -- Scoped to a specific fund (null = global)
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'passed', 'failed', 'expired')),
  threshold_pct   INTEGER NOT NULL DEFAULT 75,
  deadline        TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Votes ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS votes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id     TEXT NOT NULL REFERENCES proposals(id),
  voter_address   TEXT NOT NULL,
  approve         INTEGER NOT NULL CHECK (approve IN (0, 1)),
  voting_power    INTEGER NOT NULL DEFAULT 0,  -- cents (own + delegated)
  attestation     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(proposal_id, voter_address)
);

CREATE INDEX IF NOT EXISTS idx_votes_proposal ON votes(proposal_id);
