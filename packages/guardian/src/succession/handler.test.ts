import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ProtocolDatabase,
  loadConfig,
  KeyExchangeSession,
} from '@idiostasis/core';
import type {
  ProtocolConfig,
  SuccessionTransport,
  CandidateReadyResponse,
  BackupAgentRecord,
} from '@idiostasis/core';
import { SuccessionHandler } from './handler.js';

let db: ProtocolDatabase;
let tmpDir: string;
let config: ProtocolConfig;
let vaultKey: Uint8Array;

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'idiostasis-succ-h-'));
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

describe('SuccessionHandler', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('initiate() when already in progress: returns immediately, no second succession', async () => {
    db.upsertBackupAgent(makeBackup('b1', 10));
    db.setConfig('agent_rtmr3', 'abc123');

    let callCount = 0;
    const erc8004Checker = {
      async getLivePrimaryAddress() {
        callCount++;
        // Return a different address to trigger stand-down immediately
        return 'new-primary.test:8080';
      },
    };

    const handler = new SuccessionHandler(db, config, vaultKey, 'tee-guardian', erc8004Checker);
    handler.setTransport({
      async contactCandidate() { return makeCandidateResponse(); },
      async sendSuccessionPayload() { return true; },
    });
    handler.setSigner(dummySigner);

    // Fire two concurrent initiations
    const p1 = handler.initiate();
    const p2 = handler.initiate(); // Should return immediately
    await Promise.all([p1, p2]);

    // isInProgress should be false after completion
    assert.equal(handler.isInProgress(), false);
  });

  it('calls SuccessionManager.initiateSuccession()', async () => {
    db.upsertBackupAgent(makeBackup('b1', 10));
    db.setConfig('agent_rtmr3', 'abc123');

    let contacted = false;
    const erc8004Checker = {
      async getLivePrimaryAddress() { return 'new.test:8080'; },
    };

    const handler = new SuccessionHandler(db, config, vaultKey, 'tee-guardian', erc8004Checker);
    handler.setTransport({
      async contactCandidate() { contacted = true; return makeCandidateResponse(); },
      async sendSuccessionPayload() { return true; },
    });
    handler.setSigner(dummySigner);

    await handler.initiate();
    assert.equal(contacted, true);
  });

  it('on SuccessionExhaustedError: sets inProgress false', async () => {
    // No backup agents — will exhaust immediately
    const erc8004Checker = {
      async getLivePrimaryAddress() { return null; },
    };

    const handler = new SuccessionHandler(db, config, vaultKey, 'tee-guardian', erc8004Checker);
    handler.setTransport({
      async contactCandidate() { throw new Error('down'); },
      async sendSuccessionPayload() { return true; },
    });
    handler.setSigner(dummySigner);

    await handler.initiate();
    assert.equal(handler.isInProgress(), false, 'should reset inProgress after exhaustion');
  });

  it('stand-down poll: stops when registry shows new primary', async () => {
    db.upsertBackupAgent(makeBackup('b1', 10));
    db.setConfig('agent_rtmr3', 'abc123');

    const erc8004Checker = {
      async getLivePrimaryAddress() { return 'new-primary.test:8080'; },
    };

    const handler = new SuccessionHandler(db, config, vaultKey, 'tee-guardian', erc8004Checker);
    handler.setTransport({
      async contactCandidate() { return makeCandidateResponse(); },
      async sendSuccessionPayload() { return true; },
    });
    handler.setSigner(dummySigner);

    await handler.initiate();
    assert.equal(handler.isInProgress(), false, 'should have stood down');
  });
});
