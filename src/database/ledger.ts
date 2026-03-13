import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WalletState } from '../types/wallet.js';
import {
  InvariantViolationError,
  NodePausedError,
} from '../types/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface NodeState {
  id: number;
  is_paused: number;
  updated_at: string;
}

export interface NodeConfig {
  id: number;
  parameters: string;
  last_updated: string;
}

export class DatabaseLedger {
  readonly db: Database.Database;

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');

    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    this.db.exec(schema);

    // Ensure node_state singleton row exists
    this.db.prepare(
      `INSERT OR IGNORE INTO node_state (id, is_paused) VALUES (1, 0)`
    ).run();

    // Migrate solana_address → evm_address for older DBs
    this.migrateWalletColumn();

    // Ensure backup_agents table exists (for older DBs)
    this.migrateBackupAgents();
  }

  close(): void {
    this.db.close();
  }

  /** Migrate solana_address → evm_address in wallet_state for older DBs. */
  private migrateWalletColumn(): void {
    try {
      const cols = this.db.prepare(`PRAGMA table_info(wallet_state)`).all() as Array<{ name: string }>;
      if (cols.some(c => c.name === 'solana_address') && !cols.some(c => c.name === 'evm_address')) {
        this.db.exec(`ALTER TABLE wallet_state RENAME COLUMN solana_address TO evm_address`);
      }
    } catch {
      // Fresh DB or already migrated — nothing to do
    }
  }

  /** Ensure backup_agents table exists (with heartbeat_streak) for older DBs. */
  private migrateBackupAgents(): void {
    const tables = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='backup_agents'`
    ).get() as { name: string } | undefined;

    if (!tables) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS backup_agents (
          id              TEXT PRIMARY KEY,
          endpoint        TEXT NOT NULL,
          registered_at   INTEGER NOT NULL,
          last_heartbeat  INTEGER NOT NULL,
          heartbeat_streak INTEGER NOT NULL DEFAULT 0,
          status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale'))
        );
        CREATE INDEX IF NOT EXISTS idx_backup_agents_priority ON backup_agents(heartbeat_streak DESC, registered_at ASC);
      `);
    } else {
      // Add heartbeat_streak column if missing (older DBs)
      const cols = this.db.prepare(`PRAGMA table_info(backup_agents)`).all() as Array<{ name: string }>;
      if (!cols.some(c => c.name === 'heartbeat_streak')) {
        this.db.exec(`ALTER TABLE backup_agents ADD COLUMN heartbeat_streak INTEGER NOT NULL DEFAULT 0`);
        this.db.exec(`DROP INDEX IF EXISTS idx_backup_agents_registered`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_backup_agents_priority ON backup_agents(heartbeat_streak DESC, registered_at ASC)`);
      }
    }
  }

  // ── Guards ──────────────────────────────────────────────────

  private guardNotPaused(operation: string): void {
    const state = this.getNodeState();
    if (state.is_paused) {
      throw new NodePausedError(operation);
    }
  }

  // ── Node State ────────────────────────────────────────────

  getNodeState(): NodeState {
    return this.db.prepare(`SELECT * FROM node_state WHERE id = 1`).get() as NodeState;
  }

  pauseNode(): void {
    this.db.prepare(
      `UPDATE node_state SET is_paused = 1, updated_at = datetime('now') WHERE id = 1`
    ).run();
  }

  unpauseNode(): void {
    this.db.prepare(
      `UPDATE node_state SET is_paused = 0, updated_at = datetime('now') WHERE id = 1`
    ).run();
  }

  // ── Node Config ───────────────────────────────────────────

  getNodeConfig(): { parameters: Record<string, unknown>; lastUpdated: number } {
    const row = this.db.prepare(
      `SELECT * FROM node_config WHERE id = 1`
    ).get() as NodeConfig | undefined;

    if (!row) {
      return { parameters: {}, lastUpdated: 0 };
    }

    return {
      parameters: JSON.parse(row.parameters) as Record<string, unknown>,
      lastUpdated: new Date(row.last_updated).getTime(),
    };
  }

  setNodeConfig(parameters: Record<string, unknown>): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO node_config (id, parameters, last_updated)
       VALUES (1, ?, datetime('now'))`
    ).run(JSON.stringify(parameters));
  }

  // ── Invariant Verification ──────────────────────────────────

  verifyInvariants(): void {
    // Verify node_state exists
    const state = this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM node_state WHERE id = 1`
    ).get() as { cnt: number };

    if (state.cnt !== 1) {
      this.pauseNode();
      throw new InvariantViolationError(
        'NODE_STATE',
        'node_state singleton row missing',
      );
    }
  }

  // ── Governance Config (key-value) ──────────────────────────

  getConfigValue(key: string): string | null {
    const row = this.db.prepare(
      `SELECT value FROM governance_config WHERE key = ?`
    ).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setConfigValue(key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO governance_config (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, value);
  }

  deleteConfigValue(key: string): void {
    this.db.prepare(`DELETE FROM governance_config WHERE key = ?`).run(key);
  }

  // ── Wallet State ──────────────────────────────────────────

  getWalletState(): WalletState | null {
    return (this.db.prepare(
      `SELECT * FROM wallet_state WHERE id = 1`
    ).get() as WalletState | undefined) ?? null;
  }

  saveWalletState(state: Omit<WalletState, 'id' | 'created_at' | 'updated_at'>): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO wallet_state (id, mnemonic, evm_address, updated_at)
       VALUES (1, ?, ?, datetime('now'))`
    ).run(
      state.mnemonic,
      state.evm_address,
    );
  }

  // ── Backup Agent Registry ──────────────────────────────────

  /** Register a backup agent. On re-register, keeps existing streak. Returns priority position. */
  registerBackupAgent(id: string, endpoint: string): number {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO backup_agents (id, endpoint, registered_at, last_heartbeat, heartbeat_streak, status)
       VALUES (?, ?, ?, ?, 0, 'active')
       ON CONFLICT(id) DO UPDATE SET
         endpoint = excluded.endpoint,
         last_heartbeat = excluded.last_heartbeat,
         status = 'active'`
    ).run(id, endpoint, now, now);

    // Return position (1-based, ordered by priority: streak DESC, registered_at ASC)
    const row = this.db.prepare(
      `SELECT COUNT(*) AS pos FROM backup_agents
       WHERE heartbeat_streak > (SELECT heartbeat_streak FROM backup_agents WHERE id = ?)
          OR (heartbeat_streak = (SELECT heartbeat_streak FROM backup_agents WHERE id = ?)
              AND registered_at <= (SELECT registered_at FROM backup_agents WHERE id = ?))`
    ).get(id, id, id) as { pos: number };
    return row.pos;
  }

  /** Update heartbeat timestamp for a backup agent. Increments streak if on-time, resets if late. */
  backupAgentHeartbeat(id: string, endpoint?: string): boolean {
    const now = Date.now();
    // 6 min grace window (5 min interval + 1 min grace = 360000ms)
    const GRACE_MS = 360_000;
    let result;
    if (endpoint) {
      result = this.db.prepare(
        `UPDATE backup_agents SET
           last_heartbeat = ?,
           endpoint = ?,
           heartbeat_streak = CASE WHEN (? - last_heartbeat) <= ? THEN heartbeat_streak + 1 ELSE 0 END,
           status = 'active'
         WHERE id = ?`
      ).run(now, endpoint, now, GRACE_MS, id);
    } else {
      result = this.db.prepare(
        `UPDATE backup_agents SET
           last_heartbeat = ?,
           heartbeat_streak = CASE WHEN (? - last_heartbeat) <= ? THEN heartbeat_streak + 1 ELSE 0 END,
           status = 'active'
         WHERE id = ?`
      ).run(now, now, GRACE_MS, id);
    }
    return result.changes > 0;
  }

  /** Get all backup agents ordered by priority (highest streak first, then oldest). */
  getBackupAgents(): Array<{ id: string; endpoint: string; registered_at: number; last_heartbeat: number; heartbeat_streak: number; status: string }> {
    return this.db.prepare(
      `SELECT * FROM backup_agents ORDER BY heartbeat_streak DESC, registered_at ASC`
    ).all() as Array<{ id: string; endpoint: string; registered_at: number; last_heartbeat: number; heartbeat_streak: number; status: string }>;
  }

  /** Get backup agents with fresh heartbeats (within maxStaleMs), ordered by priority. */
  getFreshBackupAgents(maxStaleMs: number): Array<{ id: string; endpoint: string; registered_at: number; last_heartbeat: number; heartbeat_streak: number; status: string }> {
    const cutoff = Date.now() - maxStaleMs;
    return this.db.prepare(
      `SELECT * FROM backup_agents WHERE last_heartbeat > ? ORDER BY heartbeat_streak DESC, registered_at ASC`
    ).all(cutoff) as Array<{ id: string; endpoint: string; registered_at: number; last_heartbeat: number; heartbeat_streak: number; status: string }>;
  }

  /** Remove a backup agent by ID. */
  removeBackupAgent(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM backup_agents WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  /** Prune backup agents whose last heartbeat is older than maxStaleMs. Returns count deleted. */
  pruneStaleBackupAgents(maxStaleMs: number): number {
    const cutoff = Date.now() - maxStaleMs;
    const result = this.db.prepare(
      `DELETE FROM backup_agents WHERE last_heartbeat < ?`
    ).run(cutoff);
    return result.changes;
  }
}
