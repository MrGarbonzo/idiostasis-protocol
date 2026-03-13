-- Idiostasis Protocol — Database Schema
-- Core infrastructure: wallet, node state, backup agents, governance config

-- ── Node State ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS node_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  is_paused  INTEGER NOT NULL DEFAULT 0 CHECK (is_paused IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Node Config ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS node_config (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  parameters   TEXT NOT NULL DEFAULT '{}',
  last_updated TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO node_config (id, parameters) VALUES (1, '{}');

-- ── Wallet State ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallet_state (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  mnemonic         TEXT NOT NULL,
  evm_address      TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Governance Config (key-value store for sentry-approved config) ──
CREATE TABLE IF NOT EXISTS governance_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Backup Agent Registry ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS backup_agents (
  id              TEXT PRIMARY KEY,           -- ed25519 pubkey (base64)
  endpoint        TEXT NOT NULL,              -- http://ip:port
  registered_at   INTEGER NOT NULL,           -- epoch ms
  last_heartbeat  INTEGER NOT NULL,           -- epoch ms
  heartbeat_streak INTEGER NOT NULL DEFAULT 0, -- current consecutive on-time heartbeats (resets on miss)
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale'))
);

CREATE INDEX IF NOT EXISTS idx_backup_agents_priority ON backup_agents(heartbeat_streak DESC, registered_at ASC);
