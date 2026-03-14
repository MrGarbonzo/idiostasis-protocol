import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProtocolDatabase } from '../database/db.js';
import { SuccessionManager, SuccessionExhaustedError } from './manager.js';
import type { SuccessionTransport, CandidateReadyResponse, Erc8004Checker } from './manager.js';
import { loadConfig } from '../config.js';
import { KeyExchangeSession } from '../vault/exchange.js';
import type { BackupAgentRecord, ProtocolConfig } from '../interfaces.js';

let db: ProtocolDatabase;
let tmpDir: string;
let config: ProtocolConfig;
let vaultKey: Uint8Array;

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'idiostasis-succ-'));
  vaultKey = new Uint8Array(randomBytes(32));
  db = new ProtocolDatabase(join(tmpDir, 'test.db'), vaultKey);
  config = loadConfig({});
}

function teardown() {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
}

function makeBackup(id: string, streak: number): BackupAgentRecord {
  return {
    id,
    networkAddress: `${id}.test:8080`,
    teeInstanceId: `tee-${id}`,
    rtmr3: 'abc123',
    registeredAt: new Date(),
    heartbeatStreak: streak,
    lastHeartbeatAt: new Date(),
    status: 'standby',
  };
}

const dummySigner = async () => new Uint8Array(64);

async function makeCandidateResponse(): Promise<CandidateReadyResponse> {
  const session = await KeyExchangeSession.generate();
  const keys = session.getPublicKeys();
  return {
    rtmr3: 'abc123',
    x25519PublicKey: keys.x25519,
    ed25519PublicKey: keys.ed25519,
    ed25519Signature: keys.signature,
  };
}

describe('SuccessionManager', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('initiateSuccession calls selectSuccessor with standby agents only', async () => {
    db.upsertBackupAgent(makeBackup('b1', 10));
    db.upsertBackupAgent({ ...makeBackup('b2', 20), status: 'inactive' });
    db.setConfig('agent_rtmr3', 'abc123');

    let contactedAddress = '';
    const transport: SuccessionTransport = {
      async contactCandidate(addr) {
        contactedAddress = addr;
        return makeCandidateResponse();
      },
      async sendSuccessionPayload() { return true; },
    };

    let completedWith = '';
    const mgr = new SuccessionManager(db, config, 'tee-guardian', vaultKey,
      async (addr) => { completedWith = addr; });

    await mgr.initiateSuccession(transport, dummySigner);
    // Only b1 is standby, b2 is inactive
    assert.equal(contactedAddress, 'b1.test:8080');
    assert.equal(completedWith, 'b1.test:8080');
  });

  it('skips candidate on RTMR3 mismatch, tries next', async () => {
    db.upsertBackupAgent(makeBackup('b1', 10));
    db.upsertBackupAgent(makeBackup('b2', 5));
    db.setConfig('agent_rtmr3', 'abc123');

    const contacted: string[] = [];
    const transport: SuccessionTransport = {
      async contactCandidate(addr) {
        contacted.push(addr);
        const resp = await makeCandidateResponse();
        // First candidate returns wrong RTMR3
        if (addr === 'b1.test:8080') resp.rtmr3 = 'wrong-rtmr3';
        return resp;
      },
      async sendSuccessionPayload() { return true; },
    };

    let completedWith = '';
    const mgr = new SuccessionManager(db, config, 'tee-guardian', vaultKey,
      async (addr) => { completedWith = addr; });

    await mgr.initiateSuccession(transport, dummySigner);
    assert.equal(contacted.length, 2);
    assert.equal(completedWith, 'b2.test:8080');
  });

  it('skips candidate on network failure, tries next', async () => {
    db.upsertBackupAgent(makeBackup('b1', 10));
    db.upsertBackupAgent(makeBackup('b2', 5));
    db.setConfig('agent_rtmr3', 'abc123');

    const transport: SuccessionTransport = {
      async contactCandidate(addr) {
        if (addr === 'b1.test:8080') throw new Error('connection refused');
        return makeCandidateResponse();
      },
      async sendSuccessionPayload() { return true; },
    };

    let completedWith = '';
    const mgr = new SuccessionManager(db, config, 'tee-guardian', vaultKey,
      async (addr) => { completedWith = addr; });

    await mgr.initiateSuccession(transport, dummySigner);
    assert.equal(completedWith, 'b2.test:8080');
  });

  it('calls onSuccessionComplete with winner address', async () => {
    db.upsertBackupAgent(makeBackup('b1', 10));
    db.setConfig('agent_rtmr3', 'abc123');

    const transport: SuccessionTransport = {
      async contactCandidate() { return makeCandidateResponse(); },
      async sendSuccessionPayload() { return true; },
    };

    let completedWith = '';
    const mgr = new SuccessionManager(db, config, 'tee-guardian', vaultKey,
      async (addr) => { completedWith = addr; });

    await mgr.initiateSuccession(transport, dummySigner);
    assert.equal(completedWith, 'b1.test:8080');
  });

  it('throws SuccessionExhaustedError if all candidates fail', async () => {
    db.upsertBackupAgent(makeBackup('b1', 10));
    db.setConfig('agent_rtmr3', 'abc123');

    const transport: SuccessionTransport = {
      async contactCandidate() { throw new Error('down'); },
      async sendSuccessionPayload() { return true; },
    };

    const mgr = new SuccessionManager(db, config, 'tee-guardian', vaultKey, async () => {});

    await assert.rejects(
      mgr.initiateSuccession(transport, dummySigner),
      (err: Error) => err instanceof SuccessionExhaustedError,
    );
  });

  it('throws SuccessionExhaustedError when no standby agents exist', async () => {
    const transport: SuccessionTransport = {
      async contactCandidate() { return makeCandidateResponse(); },
      async sendSuccessionPayload() { return true; },
    };

    const mgr = new SuccessionManager(db, config, 'tee-guardian', vaultKey, async () => {});

    await assert.rejects(
      mgr.initiateSuccession(transport, dummySigner),
      (err: Error) => err instanceof SuccessionExhaustedError,
    );
  });

  it('checkAndStandDown returns true when registry shows new primary', async () => {
    const checker: Erc8004Checker = {
      async getLivePrimaryAddress() { return 'new-primary.test:8080'; },
    };

    const mgr = new SuccessionManager(db, config, 'tee-guardian', vaultKey,
      async () => {}, checker);

    assert.equal(await mgr.checkAndStandDown('old-primary.test:8080'), true);
  });

  it('checkAndStandDown returns false when registry shows no change', async () => {
    const checker: Erc8004Checker = {
      async getLivePrimaryAddress() { return 'same.test:8080'; },
    };

    const mgr = new SuccessionManager(db, config, 'tee-guardian', vaultKey,
      async () => {}, checker);

    assert.equal(await mgr.checkAndStandDown('same.test:8080'), false);
  });
});
