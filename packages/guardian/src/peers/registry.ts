import Database from 'better-sqlite3';

export interface PeerRecord {
  id: string;
  networkAddress: string;
  teeInstanceId: string;
  rtmr3: string;
  discoveredAt: number;
  lastSeenAt: number;
  discoveredVia: 'erc8004' | 'direct';
}

export class PeerRegistry {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS peers (
        id                TEXT PRIMARY KEY,
        network_address   TEXT NOT NULL,
        tee_instance_id   TEXT NOT NULL,
        rtmr3             TEXT NOT NULL,
        discovered_at     INTEGER NOT NULL,
        last_seen_at      INTEGER NOT NULL,
        discovered_via    TEXT NOT NULL CHECK (discovered_via IN ('erc8004', 'direct'))
      )
    `);
  }

  upsertPeer(peer: PeerRecord): void {
    this.db.prepare(`
      INSERT INTO peers (
        id, network_address, tee_instance_id, rtmr3,
        discovered_at, last_seen_at, discovered_via
      ) VALUES (
        @id, @networkAddress, @teeInstanceId, @rtmr3,
        @discoveredAt, @lastSeenAt, @discoveredVia
      )
      ON CONFLICT(id) DO UPDATE SET
        network_address = @networkAddress,
        tee_instance_id = @teeInstanceId,
        rtmr3 = @rtmr3,
        last_seen_at = @lastSeenAt,
        discovered_via = @discoveredVia
    `).run({
      id: peer.id,
      networkAddress: peer.networkAddress,
      teeInstanceId: peer.teeInstanceId,
      rtmr3: peer.rtmr3,
      discoveredAt: peer.discoveredAt,
      lastSeenAt: peer.lastSeenAt,
      discoveredVia: peer.discoveredVia,
    });
  }

  getPeer(id: string): PeerRecord | null {
    const row = this.db.prepare('SELECT * FROM peers WHERE id = ?').get(id) as PeerRow | undefined;
    return row ? rowToPeer(row) : null;
  }

  listPeers(): PeerRecord[] {
    const rows = this.db.prepare('SELECT * FROM peers').all() as PeerRow[];
    return rows.map(rowToPeer);
  }

  pruneStale(thresholdMs: number): number {
    const cutoff = Date.now() - thresholdMs;
    const result = this.db.prepare(
      'DELETE FROM peers WHERE last_seen_at < ?'
    ).run(cutoff);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}

interface PeerRow {
  id: string;
  network_address: string;
  tee_instance_id: string;
  rtmr3: string;
  discovered_at: number;
  last_seen_at: number;
  discovered_via: 'erc8004' | 'direct';
}

function rowToPeer(row: PeerRow): PeerRecord {
  return {
    id: row.id,
    networkAddress: row.network_address,
    teeInstanceId: row.tee_instance_id,
    rtmr3: row.rtmr3,
    discoveredAt: row.discovered_at,
    lastSeenAt: row.last_seen_at,
    discoveredVia: row.discovered_via,
  };
}
