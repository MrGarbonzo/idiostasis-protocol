import type { Database } from 'better-sqlite3';

export const CREATE_CONFIG_TABLE = `
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;

export const CREATE_GUARDIANS_TABLE = `
CREATE TABLE IF NOT EXISTS guardians (
  id                    TEXT PRIMARY KEY,
  network_address       TEXT NOT NULL,
  tee_instance_id       TEXT NOT NULL UNIQUE,
  rtmr3                 TEXT NOT NULL,
  admitted_at           INTEGER NOT NULL,
  last_attested_at      INTEGER NOT NULL,
  last_seen_at          INTEGER NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'pending_re_attestation', 'inactive')),
  provisioned_by        TEXT NOT NULL DEFAULT 'external'
    CHECK (provisioned_by IN ('agent', 'external')),
  agent_vm_id           TEXT,
  external_stable_since INTEGER
)`;

export const CREATE_BACKUP_AGENTS_TABLE = `
CREATE TABLE IF NOT EXISTS backup_agents (
  id                  TEXT PRIMARY KEY,
  network_address     TEXT NOT NULL,
  tee_instance_id     TEXT NOT NULL UNIQUE,
  rtmr3               TEXT NOT NULL,
  registered_at       INTEGER NOT NULL,
  heartbeat_streak    INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at   INTEGER,
  status              TEXT NOT NULL DEFAULT 'standby'
    CHECK (status IN ('standby', 'inactive'))
)`;

export const CREATE_AGENT_STATE_TABLE = `
CREATE TABLE IF NOT EXISTS agent_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  state_blob    BLOB NOT NULL,
  updated_at    INTEGER NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1
)`;

export const CREATE_USED_NONCES_TABLE = `
CREATE TABLE IF NOT EXISTS used_nonces (
  nonce       TEXT PRIMARY KEY,
  used_at     INTEGER NOT NULL
)`;

export const CREATE_PROTOCOL_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS protocol_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT NOT NULL,
  detail      TEXT,
  occurred_at INTEGER NOT NULL
)`;

export const CREATE_PEER_PUBLIC_KEYS_TABLE = `
CREATE TABLE IF NOT EXISTS peer_public_keys (
  tee_instance_id  TEXT PRIMARY KEY,
  ed25519_pubkey   BLOB NOT NULL,
  x25519_pubkey    BLOB,
  stored_at        INTEGER NOT NULL
)`;

export function initializeSchema(db: Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  db.exec(CREATE_CONFIG_TABLE);
  db.exec(CREATE_GUARDIANS_TABLE);
  db.exec(CREATE_BACKUP_AGENTS_TABLE);
  db.exec(CREATE_AGENT_STATE_TABLE);
  db.exec(CREATE_USED_NONCES_TABLE);
  db.exec(CREATE_PROTOCOL_EVENTS_TABLE);
  db.exec(CREATE_PEER_PUBLIC_KEYS_TABLE);
}
