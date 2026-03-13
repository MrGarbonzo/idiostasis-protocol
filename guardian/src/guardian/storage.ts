/**
 * Backup Storage — receive, store, prune, and serve fund manager DB snapshots.
 * Keeps last `maxBackups` entries (default 1000 ≈ 41 days at hourly).
 */
import type Database from 'better-sqlite3';
import type { Backup } from '../shared/types.js';

export class BackupStorage {
  private db: Database.Database;
  private maxBackups: number;

  constructor(db: Database.Database, maxBackups = 1000) {
    this.db = db;
    this.maxBackups = maxBackups;
  }

  /** Store a new backup and prune old ones. */
  store(backup: {
    timestamp: number;
    data: Buffer;
    fundManagerId: string;
    attestation?: string;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO backups (timestamp, data, fund_manager_id, attestation, size_bytes)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      backup.timestamp,
      backup.data,
      backup.fundManagerId,
      backup.attestation ?? null,
      backup.data.length,
    );

    this.prune();
    return result.lastInsertRowid as number;
  }

  /** Get the most recent backup. */
  getLatest(): Backup | undefined {
    return this.db
      .prepare('SELECT * FROM backups ORDER BY timestamp DESC LIMIT 1')
      .get() as Backup | undefined;
  }

  /** Get backup by ID. */
  getById(id: number): Backup | undefined {
    return this.db
      .prepare('SELECT * FROM backups WHERE id = ?')
      .get(id) as Backup | undefined;
  }

  /** List backups (metadata only, no BLOB data). */
  list(limit = 50): Omit<Backup, 'data'>[] {
    return this.db
      .prepare(`
        SELECT id, timestamp, fund_manager_id, attestation, size_bytes, created_at
        FROM backups ORDER BY timestamp DESC LIMIT ?
      `)
      .all(limit) as Omit<Backup, 'data'>[];
  }

  /** Total number of stored backups. */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM backups').get() as { cnt: number };
    return row.cnt;
  }

  /** Total storage used in bytes. */
  totalSizeBytes(): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(size_bytes), 0) as total FROM backups')
      .get() as { total: number };
    return row.total;
  }

  /** Remove oldest backups beyond maxBackups. */
  private prune(): void {
    const count = this.count();
    if (count <= this.maxBackups) return;

    const excess = count - this.maxBackups;
    this.db
      .prepare(`
        DELETE FROM backups WHERE id IN (
          SELECT id FROM backups ORDER BY timestamp ASC LIMIT ?
        )
      `)
      .run(excess);
  }
}
