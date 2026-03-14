import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProtocolDatabase, loadConfig } from '@idiostasis/core';
import type { ProtocolConfig, GuardianRecord } from '@idiostasis/core';
import { AutonomousGuardianManager } from './guardian-manager.js';
import type { SecretVmClient } from './guardian-manager.js';

let db: ProtocolDatabase;
let tmpDir: string;
let config: ProtocolConfig;
let vaultKey: Uint8Array;

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'idiostasis-agm-'));
  vaultKey = new Uint8Array(randomBytes(32));
  db = new ProtocolDatabase(join(tmpDir, 'test.db'), vaultKey);
  config = loadConfig({
    HEARTBEAT_INTERVAL_MS: '30000',
    LIVENESS_FAILURE_THRESHOLD: '10',
  });
}

function teardown() {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
}

function makeExternalGuardian(id: string, active = true, recentlySeen = true): GuardianRecord {
  const now = new Date();
  return {
    id,
    networkAddress: `${id}.test:8080`,
    teeInstanceId: `tee-${id}`,
    rtmr3: 'abc123',
    admittedAt: now,
    lastAttestedAt: now,
    lastSeenAt: recentlySeen ? now : new Date(Date.now() - 10 * 60 * 60 * 1000), // 10 hrs ago if not recent
    status: active ? 'active' : 'inactive',
    provisionedBy: 'external',
    agentVmId: null,
  };
}

function makeAgentGuardian(vmId = 'vm-123'): GuardianRecord {
  const now = new Date();
  return {
    id: `agent-guardian-${vmId}`,
    networkAddress: `agent.test:8080`,
    teeInstanceId: `tee-${vmId}`,
    rtmr3: 'abc123',
    admittedAt: now,
    lastAttestedAt: now,
    lastSeenAt: now,
    status: 'active',
    provisionedBy: 'agent',
    agentVmId: vmId,
  };
}

function makeClient(opts?: {
  createResult?: { vmId: string; domain: string };
  statusResult?: { status: string };
  stopped?: string[];
}): SecretVmClient {
  const stopped = opts?.stopped ?? [];
  return {
    async createVm() {
      return opts?.createResult ?? { vmId: 'new-vm-1', domain: 'new.test' };
    },
    async getVmStatus(vmId) {
      return opts?.statusResult ?? { status: 'running' };
    },
    async stopVm(vmId) {
      stopped.push(vmId);
    },
  };
}

describe('AutonomousGuardianManager', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('externalStable < 2: provisions guardian if none exists', async () => {
    // Only 1 external guardian
    db.upsertGuardian(makeExternalGuardian('ext1'));

    const client = makeClient();
    const mgr = new AutonomousGuardianManager(db, config, client);
    await mgr.evaluate();

    const guardians = db.listGuardians();
    const agentGuardian = guardians.find(g => g.provisionedBy === 'agent');
    assert.ok(agentGuardian, 'should have provisioned an agent guardian');
  });

  it('externalStable < 2: restarts guardian if it exists but is down', async () => {
    db.upsertGuardian(makeExternalGuardian('ext1'));
    db.upsertGuardian(makeAgentGuardian('vm-down'));

    let statusChecked = false;
    const client: SecretVmClient = {
      async createVm() { return { vmId: 'new-vm-2', domain: 'new.test' }; },
      async getVmStatus() {
        statusChecked = true;
        return { status: 'stopped' };
      },
      async stopVm() {},
    };

    const mgr = new AutonomousGuardianManager(db, config, client);
    await mgr.evaluate();

    assert.equal(statusChecked, true, 'should have checked VM status');
  });

  it('externalStable < 2: resets external_stable_since', async () => {
    db.upsertGuardian(makeExternalGuardian('ext1'));
    db.setConfig('external_stable_since', String(Date.now() - 100_000));

    const client = makeClient();
    const mgr = new AutonomousGuardianManager(db, config, client);
    await mgr.evaluate();

    const value = db.getConfig('external_stable_since');
    assert.equal(value, '', 'external_stable_since should be reset');
  });

  it('externalStable >= 2: sets external_stable_since if null', async () => {
    db.upsertGuardian(makeExternalGuardian('ext1'));
    db.upsertGuardian(makeExternalGuardian('ext2'));

    const client = makeClient();
    const mgr = new AutonomousGuardianManager(db, config, client);
    await mgr.evaluate();

    const value = db.getConfig('external_stable_since');
    assert.ok(value, 'external_stable_since should be set');
    const ts = parseInt(value, 10);
    assert.ok(!Number.isNaN(ts));
    assert.ok(Math.abs(ts - Date.now()) < 5000, 'should be near current time');
  });

  it('externalStable >= 2, < 24 hours: does not deprovision', async () => {
    db.upsertGuardian(makeExternalGuardian('ext1'));
    db.upsertGuardian(makeExternalGuardian('ext2'));
    db.upsertGuardian(makeAgentGuardian('vm-agent'));
    // Set stable since 1 hour ago
    db.setConfig('external_stable_since', String(Date.now() - 3_600_000));

    const stopped: string[] = [];
    const client = makeClient({ stopped });
    const mgr = new AutonomousGuardianManager(db, config, client);
    await mgr.evaluate();

    assert.equal(stopped.length, 0, 'should NOT deprovision before 24h');
    const agentG = db.listGuardians().find(g => g.provisionedBy === 'agent');
    assert.equal(agentG?.status, 'active');
  });

  it('externalStable >= 2, >= 24 hours: deprovisions agent guardian', async () => {
    db.upsertGuardian(makeExternalGuardian('ext1'));
    db.upsertGuardian(makeExternalGuardian('ext2'));
    db.upsertGuardian(makeAgentGuardian('vm-agent'));
    // Set stable since 25 hours ago
    db.setConfig('external_stable_since', String(Date.now() - 25 * 60 * 60 * 1000));

    const stopped: string[] = [];
    const client = makeClient({ stopped });
    const mgr = new AutonomousGuardianManager(db, config, client);
    await mgr.evaluate();

    assert.equal(stopped.length, 1);
    assert.equal(stopped[0], 'vm-agent');
    const agentG = db.listGuardians().find(g => g.provisionedBy === 'agent');
    assert.equal(agentG?.status, 'inactive');
  });

  it('drops below 2 after threshold: spins back up, resets clock', async () => {
    db.upsertGuardian(makeExternalGuardian('ext1'));
    db.upsertGuardian(makeExternalGuardian('ext2'));
    // Set stable since 25 hours ago, agent guardian active
    db.setConfig('external_stable_since', String(Date.now() - 25 * 60 * 60 * 1000));
    db.upsertGuardian(makeAgentGuardian('vm-agent'));

    const stopped: string[] = [];
    const client = makeClient({ stopped });
    const mgr = new AutonomousGuardianManager(db, config, client);

    // First evaluate: deprovisions
    await mgr.evaluate();
    assert.equal(stopped.length, 1);

    // Now remove one external guardian (simulating failure)
    db.removeGuardian('ext2');

    // Second evaluate: should provision new agent guardian
    await mgr.evaluate();

    const value = db.getConfig('external_stable_since');
    assert.equal(value, '', 'clock should be reset');

    const agentGuardians = db.listGuardians().filter(g => g.provisionedBy === 'agent');
    // There should be the deprovisioned one (inactive) plus the new one
    const activeAgent = agentGuardians.find(g => g.status === 'active');
    assert.ok(activeAgent, 'new agent guardian should be provisioned');
  });

  it('provisionGuardian logs GUARDIAN_PROVISIONED event', async () => {
    const client = makeClient();
    const mgr = new AutonomousGuardianManager(db, config, client);
    await mgr.evaluate();

    const events = db.getRecentEvents(5);
    const provEvent = events.find(e => e.eventType === 'guardian_provisioned');
    assert.ok(provEvent, 'should have logged GUARDIAN_PROVISIONED');
    assert.ok(provEvent.detail?.startsWith('vm:'));
  });

  it('deprovisionGuardian logs GUARDIAN_DEPROVISIONED event', async () => {
    db.upsertGuardian(makeExternalGuardian('ext1'));
    db.upsertGuardian(makeExternalGuardian('ext2'));
    db.upsertGuardian(makeAgentGuardian('vm-agent'));
    db.setConfig('external_stable_since', String(Date.now() - 25 * 60 * 60 * 1000));

    const client = makeClient();
    const mgr = new AutonomousGuardianManager(db, config, client);
    await mgr.evaluate();

    const events = db.getRecentEvents(5);
    const deprovEvent = events.find(e => e.eventType === 'guardian_deprovisioned');
    assert.ok(deprovEvent, 'should have logged GUARDIAN_DEPROVISIONED');
    assert.ok(deprovEvent.detail?.startsWith('vm:'));
  });
});
