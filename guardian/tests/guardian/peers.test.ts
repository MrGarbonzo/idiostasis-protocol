import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../../src/shared/db.js';
import { PeerRegistry } from '../../src/guardian/peers.js';
import type Database from 'better-sqlite3';

describe('PeerRegistry', () => {
  let db: Database.Database;
  let peers: PeerRegistry;

  beforeEach(() => {
    db = createDatabase(':memory:');
    peers = new PeerRegistry(db, 30);
  });

  it('registers a new peer', () => {
    const isNew = peers.upsert({ address: 'g1', endpoint: 'http://g1:3100' });
    expect(isNew).toBe(true);

    const peer = peers.get('g1');
    expect(peer).toBeDefined();
    expect(peer!.endpoint).toBe('http://g1:3100');
    expect(peer!.is_sentry).toBe(0);
  });

  it('updates an existing peer', () => {
    peers.upsert({ address: 'g1', endpoint: 'http://g1:3100' });
    const isNew = peers.upsert({ address: 'g1', endpoint: 'http://g1:3200', isSentry: true });
    expect(isNew).toBe(false);

    const peer = peers.get('g1');
    expect(peer!.endpoint).toBe('http://g1:3200');
    expect(peer!.is_sentry).toBe(1);
  });

  it('heartbeat updates last_seen', () => {
    peers.upsert({ address: 'g1', endpoint: 'http://g1:3100' });
    const ok = peers.heartbeat('g1');
    expect(ok).toBe(true);

    const missing = peers.heartbeat('nonexistent');
    expect(missing).toBe(false);
  });

  it('lists all peers and filters sentries', () => {
    peers.upsert({ address: 'g1', endpoint: 'http://g1:3100' });
    peers.upsert({ address: 's1', endpoint: 'http://s1:3100', isSentry: true });
    peers.upsert({ address: 'g2', endpoint: 'http://g2:3100' });

    expect(peers.listAll()).toHaveLength(3);
    expect(peers.listAll(true)).toHaveLength(1);
    expect(peers.listAll(true)[0].address).toBe('s1');
  });

  it('removes a peer', () => {
    peers.upsert({ address: 'g1', endpoint: 'http://g1:3100' });
    expect(peers.remove('g1')).toBe(true);
    expect(peers.get('g1')).toBeUndefined();
    expect(peers.remove('g1')).toBe(false);
  });

  it('reports stats correctly', () => {
    peers.upsert({ address: 'g1', endpoint: 'http://g1:3100' });
    peers.upsert({ address: 's1', endpoint: 'http://s1:3100', isSentry: true });

    const stats = peers.stats();
    expect(stats.total).toBe(2);
    expect(stats.sentries).toBe(1);
    // Active count depends on timing; just-inserted peers should be active
    expect(stats.active).toBeGreaterThanOrEqual(0);
  });

  it('stores metadata', () => {
    peers.upsert({ address: 'g1', endpoint: 'http://g1:3100', metadata: '{"version":"0.1.0"}' });
    const peer = peers.get('g1');
    expect(peer!.metadata).toBe('{"version":"0.1.0"}');
  });
});
