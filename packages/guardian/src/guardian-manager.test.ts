import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProtocolDatabase, loadConfig } from '@idiostasis/core';
import type { ProtocolConfig, GuardianRecord } from '@idiostasis/core';
import { AutonomousNetworkManager, AutonomousGuardianManager } from './guardian-manager.js';
import type { SecretVmClient } from './guardian-manager.js';

let db: ProtocolDatabase;
let tmpDir: string;
let config: ProtocolConfig;
let vaultKey: Uint8Array;

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'idiostasis-anm-'));
  vaultKey = new Uint8Array(randomBytes(32));
  db = new ProtocolDatabase(join(tmpDir, 'test.db'), vaultKey);
  config = loadConfig({
    HEARTBEAT_INTERVAL_MS: '30000',
    LIVENESS_FAILURE_THRESHOLD: '10',
  });
  // Pre-seed required DB keys
  db.setConfig('backup_rtmr3', 'test-rtmr3');
  db.setConfig('guardian_compose', 'services:\n  guardian:\n    image: test');
  db.setConfig('agent_compose', 'services:\n  agent:\n    image: test');
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
    lastSeenAt: recentlySeen ? now : new Date(Date.now() - 10 * 60 * 60 * 1000),
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
  stopped?: string[];
}): SecretVmClient {
  const stopped = opts?.stopped ?? [];
  return {
    async createVm() {
      return opts?.createResult ?? { vmId: 'new-vm-1', domain: 'new.test' };
    },
    async getVmStatus() {
      return { status: 'running' };
    },
    async stopVm(vmId) {
      stopped.push(vmId);
    },
  };
}

function makeMgr(client: SecretVmClient, tvl = 0): AutonomousNetworkManager {
  const mgr = new AutonomousNetworkManager({
    db,
    config,
    secretvmClient: client,
    getTvlUsdc: async () => tvl,
  });
  // Override startup delay for tests
  (mgr as any).startedAt = Date.now() - 31 * 60 * 1000;
  return mgr;
}

describe('AutonomousNetworkManager', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('base tier: provisions 1 guardian when none exist', async () => {
    // Seed deficit timer to bypass 10-min wait
    db.setConfig('guardian_deficit_since', String(Date.now() - 11 * 60 * 1000));

    const client = makeClient();
    const mgr = makeMgr(client, 500); // low TVL = base tier
    await mgr.evaluate();

    const guardians = db.listGuardians();
    const agentGuardian = guardians.find(g => g.provisionedBy === 'agent');
    assert.ok(agentGuardian, 'should have provisioned an agent guardian');
  });

  it('base tier: does not provision when 1 guardian exists', async () => {
    db.upsertGuardian(makeExternalGuardian('ext1'));

    const client = makeClient();
    const mgr = makeMgr(client, 500); // base tier targets 1
    await mgr.evaluate();

    const agentGuardians = db.listGuardians().filter(g => g.provisionedBy === 'agent');
    assert.equal(agentGuardians.length, 0, 'should NOT provision — already have 1');
  });

  it('scaled tier: provisions to reach 2 guardians', async () => {
    db.upsertGuardian(makeExternalGuardian('ext1'));
    db.setConfig('guardian_deficit_since', String(Date.now() - 11 * 60 * 1000));

    const client = makeClient();
    const mgr = makeMgr(client, 15000); // above tier1 = scaled
    await mgr.evaluate();

    const agentGuardians = db.listGuardians().filter(g => g.provisionedBy === 'agent');
    assert.equal(agentGuardians.length, 1, 'should provision 1 to reach target of 2');
  });

  it('scaled tier: does not provision when 2 guardians exist', async () => {
    db.upsertGuardian(makeExternalGuardian('ext1'));
    db.upsertGuardian(makeExternalGuardian('ext2'));

    const client = makeClient();
    const mgr = makeMgr(client, 15000);
    await mgr.evaluate();

    const agentGuardians = db.listGuardians().filter(g => g.provisionedBy === 'agent');
    assert.equal(agentGuardians.length, 0, 'should NOT provision — already at target');
  });

  it('spins down excess agent guardians when over target', async () => {
    db.upsertGuardian(makeExternalGuardian('ext1'));
    db.upsertGuardian(makeExternalGuardian('ext2'));
    db.upsertGuardian(makeAgentGuardian('vm-agent'));

    const stopped: string[] = [];
    const client = makeClient({ stopped });
    const mgr = makeMgr(client, 500); // base tier targets 1, have 3

    await mgr.evaluate();

    assert.ok(stopped.length > 0, 'should spin down excess');
  });

  it('provisionGuardian logs GUARDIAN_PROVISIONED event', async () => {
    db.setConfig('guardian_deficit_since', String(Date.now() - 11 * 60 * 1000));

    const client = makeClient();
    const mgr = makeMgr(client, 500);
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

    const client = makeClient();
    const mgr = makeMgr(client, 500); // base tier, 3 guardians = excess

    await mgr.evaluate();

    const events = db.getRecentEvents(5);
    const deprovEvent = events.find(e => e.eventType === 'guardian_deprovisioned');
    assert.ok(deprovEvent, 'should have logged GUARDIAN_DEPROVISIONED');
  });

  it('skips if backup_rtmr3 not locked', async () => {
    db.setConfig('backup_rtmr3', ''); // clear it

    const client = makeClient();
    const mgr = makeMgr(client, 500);
    await mgr.evaluate();

    const guardians = db.listGuardians();
    assert.equal(guardians.length, 0, 'should not provision without backup_rtmr3');
  });

  it('AutonomousGuardianManager is a deprecated alias', () => {
    assert.equal(AutonomousGuardianManager, AutonomousNetworkManager);
  });
});
