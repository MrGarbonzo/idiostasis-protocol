import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, generateKeyPairSync, sign, createPublicKey } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProtocolDatabase } from './db.js';
import { SnapshotManager } from './snapshot.js';
import type { DbSnapshot } from './snapshot.js';

let db: ProtocolDatabase;
let snapshotMgr: SnapshotManager;
let tmpDir: string;
let vaultKey: Uint8Array;
let ed25519PublicRaw: Uint8Array;
let signerFn: (data: Uint8Array) => Promise<Uint8Array>;

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'idiostasis-snap-'));
  const dbPath = join(tmpDir, 'test.db');
  vaultKey = new Uint8Array(randomBytes(32));
  db = new ProtocolDatabase(dbPath, vaultKey);

  // Create Ed25519 keypair for signing
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const derBuf = publicKey.export({ type: 'spki', format: 'der' });
  ed25519PublicRaw = new Uint8Array(derBuf.subarray(derBuf.length - 32));

  signerFn = async (data: Uint8Array) => {
    return new Uint8Array(sign(null, data, privateKey));
  };

  snapshotMgr = new SnapshotManager(db, vaultKey, 'test-instance');
}

function teardown() {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
}

describe('SnapshotManager — createSnapshot', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('produces valid DbSnapshot shape', async () => {
    // Add some data so snapshot is meaningful
    db.setConfig('test', 'value');

    const snapshot = await snapshotMgr.createSnapshot(signerFn);

    assert.equal(typeof snapshot.encryptedDb, 'string');
    assert.equal(typeof snapshot.iv, 'string');
    assert.equal(typeof snapshot.authTag, 'string');
    assert.equal(typeof snapshot.sequenceNum, 'number');
    assert.equal(typeof snapshot.checksum, 'string');
    assert.equal(snapshot.signedBy, 'test-instance');
    assert.equal(typeof snapshot.signature, 'string');
    assert.equal(typeof snapshot.timestamp, 'number');
    assert.equal(snapshot.sequenceNum, 1);
  });
});

describe('SnapshotManager — verifySnapshot', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns true for valid snapshot', async () => {
    db.setConfig('test', 'value');
    const snapshot = await snapshotMgr.createSnapshot(signerFn);
    assert.equal(snapshotMgr.verifySnapshot(snapshot, ed25519PublicRaw), true);
  });

  it('returns false for tampered encryptedDb', async () => {
    const snapshot = await snapshotMgr.createSnapshot(signerFn);
    const tampered: DbSnapshot = { ...snapshot, encryptedDb: 'dGFtcGVyZWQ=' };
    assert.equal(snapshotMgr.verifySnapshot(tampered, ed25519PublicRaw), false);
  });

  it('returns false for wrong signer key', async () => {
    const snapshot = await snapshotMgr.createSnapshot(signerFn);
    const { publicKey: wrongKey } = generateKeyPairSync('ed25519');
    const wrongDer = wrongKey.export({ type: 'spki', format: 'der' });
    const wrongRaw = new Uint8Array(wrongDer.subarray(wrongDer.length - 32));
    assert.equal(snapshotMgr.verifySnapshot(snapshot, wrongRaw), false);
  });
});

describe('SnapshotManager — validateSequenceNum', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('rejects equal sequence number', async () => {
    const snapshot = await snapshotMgr.createSnapshot(signerFn);
    assert.equal(snapshotMgr.validateSequenceNum(snapshot, snapshot.sequenceNum), false);
  });

  it('rejects lower sequence number', async () => {
    const snapshot = await snapshotMgr.createSnapshot(signerFn);
    assert.equal(snapshotMgr.validateSequenceNum(snapshot, snapshot.sequenceNum + 5), false);
  });

  it('accepts strictly higher sequence number', async () => {
    const snapshot = await snapshotMgr.createSnapshot(signerFn);
    assert.equal(snapshotMgr.validateSequenceNum(snapshot, snapshot.sequenceNum - 1), true);
  });
});
