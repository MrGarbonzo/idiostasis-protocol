/**
 * RPC Registry — manage, query, and serve the RPC endpoint list.
 * Actual testing logic lives in C2 (rpc-tester.ts). This module handles CRUD + queries.
 */
import type Database from 'better-sqlite3';
import type { RpcEntry, RpcTestResult, RpcStatus } from '../shared/types.js';

export class RpcRegistry {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Add a new RPC endpoint. Returns the new entry's ID. */
  add(entry: { chain: string; url: string; addedBy: string }): number {
    const stmt = this.db.prepare(`
      INSERT INTO rpc_registry (chain, url, added_by)
      VALUES (?, ?, ?)
    `);
    const result = stmt.run(entry.chain, entry.url, entry.addedBy);
    return result.lastInsertRowid as number;
  }

  /** Get a single RPC entry by ID. */
  getById(id: number): RpcEntry | undefined {
    return this.db
      .prepare('SELECT * FROM rpc_registry WHERE id = ?')
      .get(id) as RpcEntry | undefined;
  }

  /** Get a single RPC entry by URL. */
  getByUrl(url: string): RpcEntry | undefined {
    return this.db
      .prepare('SELECT * FROM rpc_registry WHERE url = ?')
      .get(url) as RpcEntry | undefined;
  }

  /** List RPCs for a chain, ordered by reputation (highest first). */
  listByChain(chain: string, includeDeprecated = false): RpcEntry[] {
    if (includeDeprecated) {
      return this.db
        .prepare('SELECT * FROM rpc_registry WHERE chain = ? ORDER BY reputation DESC')
        .all(chain) as RpcEntry[];
    }
    return this.db
      .prepare(
        "SELECT * FROM rpc_registry WHERE chain = ? AND status != 'deprecated' ORDER BY reputation DESC",
      )
      .all(chain) as RpcEntry[];
  }

  /** List all RPCs, optionally filtered by status. */
  listAll(statusFilter?: RpcStatus): RpcEntry[] {
    if (statusFilter) {
      return this.db
        .prepare('SELECT * FROM rpc_registry WHERE status = ? ORDER BY reputation DESC')
        .all(statusFilter) as RpcEntry[];
    }
    return this.db
      .prepare('SELECT * FROM rpc_registry ORDER BY reputation DESC')
      .all() as RpcEntry[];
  }

  /** Get the best (highest reputation, active) RPC for a chain. */
  getBest(chain: string): RpcEntry | undefined {
    return this.db
      .prepare(
        "SELECT * FROM rpc_registry WHERE chain = ? AND status = 'active' ORDER BY reputation DESC LIMIT 1",
      )
      .get(chain) as RpcEntry | undefined;
  }

  /** Update RPC status. */
  setStatus(id: number, status: RpcStatus): boolean {
    const result = this.db
      .prepare("UPDATE rpc_registry SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, id);
    return result.changes > 0;
  }

  /** Adjust reputation by delta. */
  adjustReputation(id: number, delta: number): number {
    this.db
      .prepare(
        "UPDATE rpc_registry SET reputation = reputation + ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(delta, id);
    const entry = this.getById(id);
    return entry?.reputation ?? 0;
  }

  /** Update latency and last_tested after a test. */
  recordTestResult(
    rpcId: number,
    result: { success: boolean; latencyMs: number | null; error: string | null },
  ): void {
    // Insert test result
    this.db
      .prepare('INSERT INTO rpc_test_results (rpc_id, success, latency_ms, error) VALUES (?, ?, ?, ?)')
      .run(rpcId, result.success ? 1 : 0, result.latencyMs, result.error);

    // Update the RPC entry
    this.db
      .prepare(
        "UPDATE rpc_registry SET last_tested = datetime('now'), latency_ms = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(result.latencyMs, rpcId);

    // Adjust reputation
    this.adjustReputation(rpcId, result.success ? 1 : -3);
  }

  /** Get test history for an RPC endpoint. */
  getTestHistory(rpcId: number, limit = 20): RpcTestResult[] {
    return this.db
      .prepare('SELECT * FROM rpc_test_results WHERE rpc_id = ? ORDER BY tested_at DESC LIMIT ?')
      .all(rpcId, limit) as RpcTestResult[];
  }

  /** Remove an RPC entry and its test results. */
  remove(id: number): boolean {
    const del = this.db.transaction(() => {
      this.db.prepare('DELETE FROM rpc_test_results WHERE rpc_id = ?').run(id);
      return this.db.prepare('DELETE FROM rpc_registry WHERE id = ?').run(id);
    });
    return del().changes > 0;
  }

  /** Get summary stats. */
  stats(): { total: number; active: number; trial: number; deprecated: number } {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) as cnt FROM rpc_registry GROUP BY status')
      .all() as { status: RpcStatus; cnt: number }[];

    const result = { total: 0, active: 0, trial: 0, deprecated: 0 };
    for (const row of rows) {
      result[row.status] = row.cnt;
      result.total += row.cnt;
    }
    return result;
  }
}
