import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProtocolDatabase, loadConfig } from '@idiostasis/core';
import type { ProtocolConfig, PingEnvelope } from '@idiostasis/core';
import { LivenessMonitor } from './monitor.js';
import type { SuccessionInitiator } from './monitor.js';

let db: ProtocolDatabase;
let tmpDir: string;
let config: ProtocolConfig;
let vaultKey: Uint8Array;

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'idiostasis-liveness-'));
  vaultKey = new Uint8Array(randomBytes(32));
  db = new ProtocolDatabase(join(tmpDir, 'test.db'), vaultKey);
  config = loadConfig({
    HEARTBEAT_INTERVAL_MS: '100', // Fast for tests
    LIVENESS_FAILURE_THRESHOLD: '3',
  });
}

function teardown() {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
}

function makeEnvelope(overrides?: Partial<PingEnvelope>): PingEnvelope {
  return {
    teeInstanceId: 'primary-tee',
    timestamp: Date.now(),
    nonce: randomBytes(16).toString('hex'),
    signature: 'dummy-sig',
    ...overrides,
  };
}

describe('LivenessMonitor', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('onPingReceived with valid envelope: updates heartbeat manager', () => {
    const succession: SuccessionInitiator = {
      async initiate() {},
      isInProgress() { return false; },
    };
    const monitor = new LivenessMonitor(config, db, succession);

    // Before any ping, no failure (never received = not a failure)
    monitor.onPingReceived(makeEnvelope());
    // Should not throw
    monitor.stop();
  });

  it('onPingReceived with replayed nonce: ignored, no error thrown', () => {
    const succession: SuccessionInitiator = {
      async initiate() {},
      isInProgress() { return false; },
    };
    const monitor = new LivenessMonitor(config, db, succession);
    const envelope = makeEnvelope();

    monitor.onPingReceived(envelope);
    // Second call with same nonce should be silently ignored
    monitor.onPingReceived(envelope);
    monitor.stop();
  });

  it('onPingReceived with stale timestamp: ignored, no error thrown', () => {
    const succession: SuccessionInitiator = {
      async initiate() {},
      isInProgress() { return false; },
    };
    const monitor = new LivenessMonitor(config, db, succession);
    const envelope = makeEnvelope({ timestamp: Date.now() - 120_000 }); // 2 min ago

    monitor.onPingReceived(envelope);
    // Should not throw, but ping should be silently dropped
    monitor.stop();
  });

  it('polling loop: calls successionHandler.initiate() on liveness failure', async () => {
    let initiated = false;
    const succession: SuccessionInitiator = {
      async initiate() { initiated = true; },
      isInProgress() { return false; },
    };
    const monitor = new LivenessMonitor(config, db, succession);

    // Send one ping so heartbeat manager starts tracking
    monitor.onPingReceived(makeEnvelope());

    // Start monitor — polling at 100ms, threshold = 3 * 100ms = 300ms
    monitor.start();

    // Wait long enough for liveness failure to be detected
    await new Promise(r => setTimeout(r, 600));

    monitor.stop();
    assert.equal(initiated, true, 'succession should have been initiated');
  });

  it('polling loop: does not call initiate() if already in progress', async () => {
    let initiateCount = 0;
    const succession: SuccessionInitiator = {
      async initiate() { initiateCount++; },
      isInProgress() { return initiateCount > 0; },
    };
    const monitor = new LivenessMonitor(config, db, succession);

    // Send one ping so heartbeat manager starts tracking
    monitor.onPingReceived(makeEnvelope());

    monitor.start();

    // Wait for multiple poll cycles
    await new Promise(r => setTimeout(r, 600));

    monitor.stop();
    assert.equal(initiateCount, 1, 'initiate should be called exactly once');
  });
});
