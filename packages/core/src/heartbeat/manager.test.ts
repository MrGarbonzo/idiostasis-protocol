import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProtocolDatabase } from '../database/db.js';
import { HeartbeatManager } from './manager.js';
import { loadConfig } from '../config.js';
import type { BackupAgentRecord, ProtocolConfig } from '../interfaces.js';
import type { PingTransport, PingSigner } from './manager.js';

let db: ProtocolDatabase;
let tmpDir: string;
let config: ProtocolConfig;

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'idiostasis-hb-'));
  const dbPath = join(tmpDir, 'test.db');
  db = new ProtocolDatabase(dbPath, new Uint8Array(randomBytes(32)));
  config = loadConfig({
    HEARTBEAT_INTERVAL_MS: '100',
    LIVENESS_FAILURE_THRESHOLD: '3',
  });
}

function teardown() {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
}

function makeBackup(id: string): BackupAgentRecord {
  return {
    id,
    networkAddress: `${id}.test:8080`,
    teeInstanceId: `tee-${id}`,
    rtmr3: 'abc123',
    registeredAt: new Date(),
    heartbeatStreak: 0,
    lastHeartbeatAt: new Date(),
    status: 'standby',
  };
}

const dummySigner: PingSigner = async () => new Uint8Array(64);

describe('HeartbeatManager — Primary', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('incrementStreak called on successful ping', async () => {
    db.upsertBackupAgent(makeBackup('b1'));

    const transport: PingTransport = async () => true;
    const mgr = new HeartbeatManager(config, db, 'primary');
    mgr.start({ transport, signer: dummySigner, teeInstanceId: 'test-tee' });

    // Wait for first ping cycle to complete
    await new Promise(r => setTimeout(r, 50));
    mgr.stop();

    const b = db.getBackupAgent('b1');
    assert.ok(b!.heartbeatStreak > 0, `Expected streak > 0, got ${b!.heartbeatStreak}`);
  });

  it('resetStreak called on failed ping', async () => {
    db.upsertBackupAgent(makeBackup('b1'));
    db.incrementStreak('b1'); // start at 1

    const transport: PingTransport = async () => false;
    const mgr = new HeartbeatManager(config, db, 'primary');
    mgr.start({ transport, signer: dummySigner, teeInstanceId: 'test-tee' });

    await new Promise(r => setTimeout(r, 50));
    mgr.stop();

    const b = db.getBackupAgent('b1');
    assert.equal(b!.heartbeatStreak, 0);
  });

  it('pings fire in parallel (3 participants should not take 3x delay)', async () => {
    db.upsertBackupAgent(makeBackup('b1'));
    db.upsertBackupAgent(makeBackup('b2'));
    db.upsertBackupAgent(makeBackup('b3'));

    const DELAY_MS = 50;
    const transport: PingTransport = async () => {
      await new Promise(r => setTimeout(r, DELAY_MS));
      return true;
    };

    const mgr = new HeartbeatManager(config, db, 'primary');
    const start = Date.now();
    mgr.start({ transport, signer: dummySigner, teeInstanceId: 'test-tee' });

    // Wait enough for one round but not 3x sequential
    await new Promise(r => setTimeout(r, DELAY_MS + 30));
    mgr.stop();
    const elapsed = Date.now() - start;

    // If sequential, would take ~150ms. Parallel should be ~50ms + overhead.
    assert.ok(elapsed < DELAY_MS * 2.5, `Pings appear sequential: took ${elapsed}ms`);
  });
});

describe('HeartbeatManager — Guardian', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('isLivenessFailure returns false before any ping received', () => {
    const mgr = new HeartbeatManager(config, db, 'guardian');
    assert.equal(mgr.isLivenessFailure(), false);
  });

  it('isLivenessFailure returns false within threshold', () => {
    const mgr = new HeartbeatManager(config, db, 'guardian');
    mgr.onPingReceived();
    assert.equal(mgr.isLivenessFailure(), false);
  });

  it('isLivenessFailure returns true after threshold exceeded', async () => {
    // threshold = 3 * 100ms = 300ms
    const mgr = new HeartbeatManager(config, db, 'guardian');
    mgr.onPingReceived();

    await new Promise(r => setTimeout(r, 350));
    assert.equal(mgr.isLivenessFailure(), true);
  });

  it('getMsSinceLastPing returns null before any ping', () => {
    const mgr = new HeartbeatManager(config, db, 'guardian');
    assert.equal(mgr.getMsSinceLastPing(), null);
  });

  it('getMsSinceLastPing returns elapsed time after ping', async () => {
    const mgr = new HeartbeatManager(config, db, 'guardian');
    mgr.onPingReceived();
    await new Promise(r => setTimeout(r, 20));
    const ms = mgr.getMsSinceLastPing()!;
    assert.ok(ms >= 15, `Expected >= 15ms, got ${ms}`);
  });
});
