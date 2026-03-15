import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MoltbookStateAdapter } from '../state/adapter.js';
import { MoltbookHealthAdapter } from '../health/adapter.js';
import { MoltbookClient } from '../moltbook/client.js';
import type { HandlerDeps } from './handlers.js';
import {
  handleAdmission,
  handlePing,
  handleEvmAddress,
  handleDiscover,
  handleWorkload,
} from './handlers.js';

function createDeps(overrides?: Partial<HandlerDeps>): HandlerDeps {
  const stateAdapter = new MoltbookStateAdapter('bot', 'Bot');
  const client = new MoltbookClient('http://test.local');
  client.ping = async () => ({ ok: true });
  const healthAdapter = new MoltbookHealthAdapter(stateAdapter, client);
  return {
    stateAdapter,
    healthAdapter,
    teeInstanceId: 'test-tee-001',
    role: 'primary',
    startTime: Date.now(),
    agentRtmr3: 'dev-measurement',
    ...overrides,
  };
}

describe('handleAdmission', () => {
  it('returns accepted:false when admissionService is not set', async () => {
    const deps = createDeps();
    const result = await handleAdmission(deps, {
      role: 'guardian',
      networkAddress: 'localhost:3000',
      teeInstanceId: 'tee-1',
      nonce: 'n1',
    });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'admission_service_not_initialized');
  });

  it('returns accepted:false for invalid body when admissionService exists', async () => {
    const mockAdmission = {
      async handleAdmissionRequest() { return { accepted: true }; },
    };
    const deps = createDeps({ admissionService: mockAdmission as any });
    const result = await handleAdmission(deps, { networkAddress: 'x', teeInstanceId: 'y' });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'invalid_request');
  });

  it('returns accepted:false for null body when admissionService exists', async () => {
    const mockAdmission = {
      async handleAdmissionRequest() { return { accepted: true }; },
    };
    const deps = createDeps({ admissionService: mockAdmission as any });
    const result = await handleAdmission(deps, null);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'invalid_request');
  });

  it('calls admissionService with correct request shape', async () => {
    let receivedReq: any = null;
    const mockAdmission = {
      async handleAdmissionRequest(req: any) {
        receivedReq = req;
        return { accepted: true };
      },
    };
    const deps = createDeps({ admissionService: mockAdmission as any });
    const result = await handleAdmission(deps, {
      role: 'guardian',
      networkAddress: 'localhost:3000',
      teeInstanceId: 'tee-1',
      rtmr3: 'dev-measurement',
      nonce: 'n1',
      timestamp: 1234567890,
    });
    assert.equal(result.accepted, true);
    assert.equal(receivedReq.role, 'guardian');
    assert.equal(receivedReq.networkAddress, 'localhost:3000');
    assert.equal(receivedReq.teeInstanceId, 'tee-1');
    assert.equal(receivedReq.nonce, 'n1');
  });
});

describe('handlePing', () => {
  it('returns ok:true with timestamp when no heartbeat manager', async () => {
    const deps = createDeps();
    const result = await handlePing(deps, {});
    assert.equal(result.ok, true);
    assert.ok(result.timestamp);
  });

  it('returns error for missing nonce field when heartbeat manager exists', async () => {
    const mockHm = { onPingReceived() {}, start() {}, stop() {}, isLivenessFailure() { return false; }, getMsSinceLastPing() { return null; } };
    const deps = createDeps({ heartbeatManager: mockHm as any });
    const result = await handlePing(deps, { teeInstanceId: 't', timestamp: 123 });
    assert.equal(result.ok, false);
    assert.match(result.error!, /missing/);
  });
});

describe('handleEvmAddress', () => {
  it('returns null address when no evmAddress set', async () => {
    const deps = createDeps();
    const result = await handleEvmAddress(deps);
    assert.equal(result.address, null);
  });

  it('returns evmAddress when set', async () => {
    const deps = createDeps({ evmAddress: '0xdeadbeef' });
    const result = await handleEvmAddress(deps);
    assert.equal(result.address, '0xdeadbeef');
  });
});

describe('handleDiscover', () => {
  it('returns networkAddress, rtmr3, timestamp', async () => {
    const deps = createDeps();
    const result = await handleDiscover(deps);
    assert.equal(result.teeInstanceId, 'test-tee-001');
    assert.equal(result.role, 'primary');
    assert.equal(result.rtmr3, 'dev-measurement');
    assert.ok(result.timestamp);
    assert.ok(result.networkAddress);
  });
});

describe('handleWorkload', () => {
  it('returns handle and displayName', async () => {
    const deps = createDeps();
    const result = await handleWorkload(deps);
    assert.equal(result.handle, 'bot');
    assert.equal(result.displayName, 'Bot');
  });
});
