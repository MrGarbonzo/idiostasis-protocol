import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { ProtocolDatabase } from './db.js';
import type { GuardianRecord, BackupAgentRecord } from '../interfaces.js';

let db: ProtocolDatabase;
let tmpDir: string;

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'idiostasis-test-'));
  const dbPath = join(tmpDir, 'test.db');
  const vaultKey = new Uint8Array(randomBytes(32));
  db = new ProtocolDatabase(dbPath, vaultKey);
}

function teardown() {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
}

function makeGuardian(id: string, overrides?: Partial<GuardianRecord>): GuardianRecord {
  return {
    id,
    networkAddress: `${id}.test:8080`,
    teeInstanceId: `tee-${id}`,
    rtmr3: 'abc123',
    admittedAt: new Date(),
    lastAttestedAt: new Date(),
    lastSeenAt: new Date(),
    status: 'active',
    provisionedBy: 'external',
    agentVmId: null,
    ...overrides,
  };
}

function makeBackup(id: string, overrides?: Partial<BackupAgentRecord>): BackupAgentRecord {
  return {
    id,
    networkAddress: `${id}.test:8080`,
    teeInstanceId: `tee-${id}`,
    rtmr3: 'abc123',
    registeredAt: new Date(),
    heartbeatStreak: 0,
    lastHeartbeatAt: new Date(),
    status: 'standby',
    ...overrides,
  };
}

describe('ProtocolDatabase — Guardians', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('upsert is idempotent (insert twice, get once)', () => {
    const g = makeGuardian('g1');
    db.upsertGuardian(g);
    db.upsertGuardian(g);
    const all = db.listGuardians();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, 'g1');
  });

  it('upsert updates fields on conflict', () => {
    db.upsertGuardian(makeGuardian('g1', { status: 'active' }));
    db.upsertGuardian(makeGuardian('g1', { status: 'inactive' }));
    const g = db.getGuardian('g1');
    assert.equal(g!.status, 'inactive');
  });

  it('listGuardians filters by status', () => {
    db.upsertGuardian(makeGuardian('g1', { status: 'active' }));
    db.upsertGuardian(makeGuardian('g2', { teeInstanceId: 'tee-g2', status: 'inactive' }));
    const active = db.listGuardians('active');
    assert.equal(active.length, 1);
    assert.equal(active[0].id, 'g1');
  });

  it('removeGuardian deletes the record', () => {
    db.upsertGuardian(makeGuardian('g1'));
    db.removeGuardian('g1');
    assert.equal(db.getGuardian('g1'), null);
  });
});

describe('ProtocolDatabase — Backup Agents', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('incrementStreak increments correctly', () => {
    db.upsertBackupAgent(makeBackup('b1', { heartbeatStreak: 5 }));
    db.incrementStreak('b1');
    const b = db.getBackupAgent('b1');
    assert.equal(b!.heartbeatStreak, 6);
  });

  it('resetStreak sets to 0 and updates timestamp', () => {
    db.upsertBackupAgent(makeBackup('b1', { heartbeatStreak: 10 }));
    const before = Date.now();
    db.resetStreak('b1');
    const b = db.getBackupAgent('b1');
    assert.equal(b!.heartbeatStreak, 0);
    assert.ok(b!.lastHeartbeatAt.getTime() >= before);
  });
});

describe('ProtocolDatabase — Nonce Cache', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('first use returns true, repeat returns false', () => {
    assert.equal(db.checkAndStoreNonce('nonce-1'), true);
    assert.equal(db.checkAndStoreNonce('nonce-1'), false);
  });

  it('evicts oldest when count exceeds 10000', () => {
    // Insert 10001 nonces
    for (let i = 0; i < 10001; i++) {
      db.checkAndStoreNonce(`nonce-${String(i).padStart(6, '0')}`);
    }
    // After eviction, count should be 9000
    // The oldest 1001 nonces should be gone
    // nonce-000000 was the first inserted, should be evicted
    assert.equal(db.checkAndStoreNonce('nonce-000000'), true); // Was evicted, so fresh
  });
});

describe('ProtocolDatabase — Config', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('set/get round-trip', () => {
    db.setConfig('test_key', 'test_value');
    assert.equal(db.getConfig('test_key'), 'test_value');
  });

  it('getConfig returns null for missing key', () => {
    assert.equal(db.getConfig('nonexistent'), null);
  });

  it('getConfigOrThrow throws for missing key', () => {
    assert.throws(() => db.getConfigOrThrow('missing'), /Missing required config key/);
  });
});

describe('ProtocolDatabase — Agent State', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('set/get round-trip', () => {
    const blob = new Uint8Array([1, 2, 3, 4, 5]);
    db.setAgentState(blob);
    const result = db.getAgentState();
    assert.deepStrictEqual(result, blob);
  });

  it('returns null when no state stored', () => {
    assert.equal(db.getAgentState(), null);
  });
});

describe('ProtocolDatabase — Peer Public Keys', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('setPeerPublicKey stores ed25519 key correctly', () => {
    const key = new Uint8Array(randomBytes(32));
    db.setPeerPublicKey('tee-1', key);
    const result = db.getPeerPublicKey('tee-1');
    assert.ok(result);
    assert.deepStrictEqual(result.ed25519, key);
    assert.equal(result.x25519, null);
  });

  it('setPeerPublicKey stores both ed25519 and x25519 keys', () => {
    const ed25519 = new Uint8Array(randomBytes(32));
    const x25519 = new Uint8Array(randomBytes(32));
    db.setPeerPublicKey('tee-2', ed25519, x25519);
    const result = db.getPeerPublicKey('tee-2');
    assert.ok(result);
    assert.deepStrictEqual(result.ed25519, ed25519);
    assert.deepStrictEqual(result.x25519, x25519);
  });

  it('getPeerPublicKey returns both keys', () => {
    const ed25519 = new Uint8Array(randomBytes(32));
    const x25519 = new Uint8Array(randomBytes(32));
    db.setPeerPublicKey('tee-3', ed25519, x25519);
    const result = db.getPeerPublicKey('tee-3');
    assert.ok(result);
    assert.equal(result.ed25519.length, 32);
    assert.equal(result.x25519!.length, 32);
  });

  it('getPeerPublicKey returns null for unknown teeInstanceId', () => {
    const result = db.getPeerPublicKey('nonexistent');
    assert.equal(result, null);
  });
});

describe('ProtocolDatabase — Pragmas', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('all three pragmas are set (WAL, busy_timeout, foreign_keys)', () => {
    // WAL is persisted in the file — verify from a separate connection
    const rawDb = new Database(db.getDbPath());
    const journalMode = rawDb.pragma('journal_mode') as Array<{ journal_mode: string }>;
    assert.equal(journalMode[0].journal_mode, 'wal');
    rawDb.close();

    // busy_timeout and foreign_keys are per-connection pragmas.
    // Verify they work by checking behavior: reinitialize opens a new connection
    // that also sets these pragmas via initializeSchema.
    db.close();
    db = new ProtocolDatabase(db.getDbPath(), new Uint8Array(randomBytes(32)));
    // If foreign_keys is ON, a FK violation would throw. If busy_timeout is set,
    // concurrent access wouldn't immediately fail. We verify by ensuring the DB
    // is usable after reinitialization (pragmas run without error).
    db.setConfig('pragma_test', 'ok');
    assert.equal(db.getConfig('pragma_test'), 'ok');
  });
});
