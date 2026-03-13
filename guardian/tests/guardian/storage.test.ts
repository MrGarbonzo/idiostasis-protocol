import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../../src/shared/db.js';
import { BackupStorage } from '../../src/guardian/storage.js';
import type Database from 'better-sqlite3';

describe('BackupStorage', () => {
  let db: Database.Database;
  let storage: BackupStorage;

  beforeEach(() => {
    db = createDatabase(':memory:');
    storage = new BackupStorage(db, 5); // small limit for testing
  });

  it('stores and retrieves a backup', () => {
    const data = Buffer.from('test-backup-data');
    const id = storage.store({
      timestamp: 1000,
      data,
      fundManagerId: 'fm-1',
      attestation: 'att-123',
    });

    expect(id).toBe(1);
    const backup = storage.getById(id);
    expect(backup).toBeDefined();
    expect(backup!.timestamp).toBe(1000);
    expect(backup!.fund_manager_id).toBe('fm-1');
    expect(backup!.attestation).toBe('att-123');
    expect(backup!.size_bytes).toBe(data.length);
    expect(Buffer.from(backup!.data)).toEqual(data);
  });

  it('getLatest returns the most recent backup', () => {
    storage.store({ timestamp: 100, data: Buffer.from('a'), fundManagerId: 'fm' });
    storage.store({ timestamp: 300, data: Buffer.from('c'), fundManagerId: 'fm' });
    storage.store({ timestamp: 200, data: Buffer.from('b'), fundManagerId: 'fm' });

    const latest = storage.getLatest();
    expect(latest!.timestamp).toBe(300);
  });

  it('list returns metadata without BLOB data', () => {
    storage.store({ timestamp: 100, data: Buffer.from('x'), fundManagerId: 'fm' });
    const list = storage.list();
    expect(list).toHaveLength(1);
    expect((list[0] as any).data).toBeUndefined();
    expect(list[0].size_bytes).toBe(1);
  });

  it('prunes oldest backups beyond maxBackups', () => {
    for (let i = 1; i <= 7; i++) {
      storage.store({ timestamp: i * 100, data: Buffer.from(`d${i}`), fundManagerId: 'fm' });
    }
    // maxBackups = 5, so 2 oldest should be pruned
    expect(storage.count()).toBe(5);
    const list = storage.list();
    // Oldest remaining should be timestamp 300 (i=3)
    expect(list[list.length - 1].timestamp).toBe(300);
  });

  it('counts and totals correctly', () => {
    storage.store({ timestamp: 1, data: Buffer.from('hello'), fundManagerId: 'fm' });
    storage.store({ timestamp: 2, data: Buffer.from('world!'), fundManagerId: 'fm' });
    expect(storage.count()).toBe(2);
    expect(storage.totalSizeBytes()).toBe(11); // 5 + 6
  });

  it('stores without attestation', () => {
    const id = storage.store({ timestamp: 1, data: Buffer.from('x'), fundManagerId: 'fm' });
    const backup = storage.getById(id);
    expect(backup!.attestation).toBeNull();
  });
});
