import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../../src/shared/db.js';
import { RpcRegistry } from '../../src/guardian/rpc-registry.js';
import type Database from 'better-sqlite3';

describe('RpcRegistry', () => {
  let db: Database.Database;
  let registry: RpcRegistry;

  beforeEach(() => {
    db = createDatabase(':memory:');
    registry = new RpcRegistry(db);
  });

  it('adds and retrieves an RPC entry', () => {
    const id = registry.add({ chain: 'solana', url: 'https://rpc1.sol.com', addedBy: 'g1' });
    const entry = registry.getById(id);
    expect(entry).toBeDefined();
    expect(entry!.chain).toBe('solana');
    expect(entry!.url).toBe('https://rpc1.sol.com');
    expect(entry!.status).toBe('trial');
    expect(entry!.reputation).toBe(0);
  });

  it('rejects duplicate URLs', () => {
    registry.add({ chain: 'solana', url: 'https://rpc1.sol.com', addedBy: 'g1' });
    expect(() =>
      registry.add({ chain: 'solana', url: 'https://rpc1.sol.com', addedBy: 'g2' }),
    ).toThrow();
  });

  it('lists by chain ordered by reputation', () => {
    const id1 = registry.add({ chain: 'solana', url: 'https://a.sol', addedBy: 'g1' });
    const id2 = registry.add({ chain: 'solana', url: 'https://b.sol', addedBy: 'g1' });
    registry.add({ chain: 'ethereum', url: 'https://c.eth', addedBy: 'g1' });

    registry.adjustReputation(id2, 10);

    const solRpcs = registry.listByChain('solana');
    expect(solRpcs).toHaveLength(2);
    expect(solRpcs[0].url).toBe('https://b.sol'); // higher reputation first
  });

  it('getBest returns highest-reputation active RPC', () => {
    const id1 = registry.add({ chain: 'solana', url: 'https://a.sol', addedBy: 'g1' });
    const id2 = registry.add({ chain: 'solana', url: 'https://b.sol', addedBy: 'g1' });
    registry.setStatus(id1, 'active');
    registry.setStatus(id2, 'active');
    registry.adjustReputation(id2, 5);

    const best = registry.getBest('solana');
    expect(best!.url).toBe('https://b.sol');
  });

  it('excludes deprecated from listByChain by default', () => {
    const id1 = registry.add({ chain: 'solana', url: 'https://a.sol', addedBy: 'g1' });
    registry.add({ chain: 'solana', url: 'https://b.sol', addedBy: 'g1' });
    registry.setStatus(id1, 'deprecated');

    expect(registry.listByChain('solana')).toHaveLength(1);
    expect(registry.listByChain('solana', true)).toHaveLength(2);
  });

  it('records test results and adjusts reputation', () => {
    const id = registry.add({ chain: 'solana', url: 'https://a.sol', addedBy: 'g1' });

    registry.recordTestResult(id, { success: true, latencyMs: 50, error: null });
    expect(registry.getById(id)!.reputation).toBe(1);

    registry.recordTestResult(id, { success: false, latencyMs: null, error: 'timeout' });
    expect(registry.getById(id)!.reputation).toBe(-2); // 1 + (-3) = -2

    const history = registry.getTestHistory(id);
    expect(history).toHaveLength(2);
    expect(history[0].success).toBe(0); // most recent first
  });

  it('removes RPC and its test history', () => {
    const id = registry.add({ chain: 'solana', url: 'https://a.sol', addedBy: 'g1' });
    registry.recordTestResult(id, { success: true, latencyMs: 50, error: null });

    expect(registry.remove(id)).toBe(true);
    expect(registry.getById(id)).toBeUndefined();
    expect(registry.getTestHistory(id)).toHaveLength(0);
  });

  it('stats returns correct counts', () => {
    const id1 = registry.add({ chain: 'solana', url: 'https://a.sol', addedBy: 'g1' });
    registry.add({ chain: 'solana', url: 'https://b.sol', addedBy: 'g1' });
    registry.setStatus(id1, 'active');

    const stats = registry.stats();
    expect(stats.total).toBe(2);
    expect(stats.active).toBe(1);
    expect(stats.trial).toBe(1);
    expect(stats.deprecated).toBe(0);
  });

  it('getByUrl finds an entry', () => {
    registry.add({ chain: 'solana', url: 'https://a.sol', addedBy: 'g1' });
    const found = registry.getByUrl('https://a.sol');
    expect(found).toBeDefined();
    expect(found!.chain).toBe('solana');
  });
});
