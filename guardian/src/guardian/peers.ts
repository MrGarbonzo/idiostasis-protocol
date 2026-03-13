/**
 * Peer Registry — register, discover, and heartbeat guardian peers.
 */
import type Database from 'better-sqlite3';
import type { Peer } from '../shared/types.js';

export class PeerRegistry {
  private db: Database.Database;
  /** Peers not seen for this many minutes are considered stale. */
  private staleMinutes: number;

  constructor(db: Database.Database, staleMinutes = 30) {
    this.db = db;
    this.staleMinutes = staleMinutes;
  }

  /** Register or update a peer. Returns true if newly inserted. */
  upsert(peer: {
    address: string;
    endpoint: string;
    isSentry?: boolean;
    metadata?: string;
  }): boolean {
    const existing = this.get(peer.address);
    if (existing) {
      this.db
        .prepare(`
          UPDATE peers SET endpoint = ?, last_seen = datetime('now'),
            is_sentry = ?, metadata = ?
          WHERE address = ?
        `)
        .run(
          peer.endpoint,
          peer.isSentry ? 1 : 0,
          peer.metadata ?? null,
          peer.address,
        );
      return false;
    }

    this.db
      .prepare(`
        INSERT INTO peers (address, endpoint, is_sentry, metadata)
        VALUES (?, ?, ?, ?)
      `)
      .run(
        peer.address,
        peer.endpoint,
        peer.isSentry ? 1 : 0,
        peer.metadata ?? null,
      );
    return true;
  }

  /** Update last_seen timestamp (heartbeat). */
  heartbeat(address: string): boolean {
    const result = this.db
      .prepare("UPDATE peers SET last_seen = datetime('now') WHERE address = ?")
      .run(address);
    return result.changes > 0;
  }

  /** Get a single peer by address. */
  get(address: string): Peer | undefined {
    return this.db
      .prepare('SELECT * FROM peers WHERE address = ?')
      .get(address) as Peer | undefined;
  }

  /** List all peers, optionally filtering sentries only. */
  listAll(sentryOnly = false): Peer[] {
    if (sentryOnly) {
      return this.db
        .prepare('SELECT * FROM peers WHERE is_sentry = 1 ORDER BY last_seen DESC')
        .all() as Peer[];
    }
    return this.db
      .prepare('SELECT * FROM peers ORDER BY last_seen DESC')
      .all() as Peer[];
  }

  /** List peers that have been seen recently. */
  listActive(): Peer[] {
    return this.db
      .prepare(`
        SELECT * FROM peers
        WHERE last_seen >= datetime('now', '-' || ? || ' minutes')
        ORDER BY last_seen DESC
      `)
      .all(this.staleMinutes) as Peer[];
  }

  /** Remove a peer. */
  remove(address: string): boolean {
    const result = this.db
      .prepare('DELETE FROM peers WHERE address = ?')
      .run(address);
    return result.changes > 0;
  }

  /** Remove peers not seen for staleMinutes. Returns count removed. */
  pruneStale(): number {
    const result = this.db
      .prepare(`
        DELETE FROM peers
        WHERE last_seen < datetime('now', '-' || ? || ' minutes')
      `)
      .run(this.staleMinutes);
    return result.changes;
  }

  /** Count of all / active / sentry peers. */
  stats(): { total: number; active: number; sentries: number } {
    const total = (this.db.prepare('SELECT COUNT(*) as c FROM peers').get() as { c: number }).c;
    const active = (
      this.db
        .prepare("SELECT COUNT(*) as c FROM peers WHERE last_seen >= datetime('now', '-' || ? || ' minutes')")
        .get(this.staleMinutes) as { c: number }
    ).c;
    const sentries = (
      this.db.prepare('SELECT COUNT(*) as c FROM peers WHERE is_sentry = 1').get() as { c: number }
    ).c;
    return { total, active, sentries };
  }
}
