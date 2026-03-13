import { describe, it, expect, beforeEach } from 'vitest';
import { LocalRegistryClient } from '../../src/shared/registry-client.js';

describe('LocalRegistryClient', () => {
  let registry: LocalRegistryClient;

  beforeEach(() => {
    registry = new LocalRegistryClient();
  });

  it('starts with no agent', async () => {
    const agent = await registry.getCurrentAgent();
    expect(agent).toBeNull();
  });

  it('registers an agent', async () => {
    const result = await registry.registerAgent({
      teeInstanceId: 'tee-1',
      codeHash: 'code-1',
      attestation: 'att-1',
      endpoint: 'http://agent:3000',
    });

    expect(result.success).toBe(true);

    const agent = await registry.getCurrentAgent();
    expect(agent).toBeDefined();
    expect(agent!.teeInstanceId).toBe('tee-1');
    expect(agent!.codeHash).toBe('code-1');
    expect(agent!.isActive).toBe(true);
  });

  it('rejects registration when another agent is active', async () => {
    await registry.registerAgent({
      teeInstanceId: 'tee-1',
      codeHash: 'code-1',
      attestation: 'att-1',
      endpoint: 'http://agent:3000',
    });

    const result = await registry.registerAgent({
      teeInstanceId: 'tee-2',
      codeHash: 'code-2',
      attestation: 'att-2',
      endpoint: 'http://agent2:3000',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('already active');
  });

  it('allows registration after deactivation', async () => {
    await registry.registerAgent({
      teeInstanceId: 'tee-1',
      codeHash: 'code-1',
      attestation: 'att-1',
      endpoint: 'http://agent:3000',
    });

    await registry.deactivateAgent('tee-1');

    const result = await registry.registerAgent({
      teeInstanceId: 'tee-2',
      codeHash: 'code-2',
      attestation: 'att-2',
      endpoint: 'http://agent2:3000',
    });

    expect(result.success).toBe(true);
    const agent = await registry.getCurrentAgent();
    expect(agent!.teeInstanceId).toBe('tee-2');
  });

  it('accepts heartbeat from registered agent', async () => {
    await registry.registerAgent({
      teeInstanceId: 'tee-1',
      codeHash: 'code-1',
      attestation: 'att-1',
      endpoint: 'http://agent:3000',
    });

    const result = await registry.heartbeat({
      teeInstanceId: 'tee-1',
      attestation: 'att-fresh',
      timestamp: Date.now(),
    });

    expect(result.success).toBe(true);
  });

  it('rejects heartbeat from wrong agent', async () => {
    await registry.registerAgent({
      teeInstanceId: 'tee-1',
      codeHash: 'code-1',
      attestation: 'att-1',
      endpoint: 'http://agent:3000',
    });

    const result = await registry.heartbeat({
      teeInstanceId: 'tee-wrong',
      attestation: 'att',
      timestamp: Date.now(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('mismatch');
  });

  it('rejects heartbeat when no agent registered', async () => {
    const result = await registry.heartbeat({
      teeInstanceId: 'tee-1',
      attestation: 'att',
      timestamp: Date.now(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No agent');
  });

  it('checks heartbeat freshness', async () => {
    await registry.registerAgent({
      teeInstanceId: 'tee-1',
      codeHash: 'code-1',
      attestation: 'att-1',
      endpoint: 'http://agent:3000',
    });

    const check = await registry.checkHeartbeat();
    expect(check).not.toBeNull();
    expect(check!.isActive).toBe(true);
    expect(check!.secondsSinceHeartbeat).toBeLessThan(5);
    expect(check!.shouldDeactivate).toBe(false);
  });

  it('returns null for checkHeartbeat when no agent', async () => {
    const check = await registry.checkHeartbeat();
    expect(check).toBeNull();
  });

  it('deactivates the correct agent', async () => {
    await registry.registerAgent({
      teeInstanceId: 'tee-1',
      codeHash: 'code-1',
      attestation: 'att-1',
      endpoint: 'http://agent:3000',
    });

    const result = await registry.deactivateAgent('tee-1');
    expect(result.success).toBe(true);

    const agent = await registry.getCurrentAgent();
    expect(agent!.isActive).toBe(false);
  });

  it('rejects deactivation of wrong agent', async () => {
    await registry.registerAgent({
      teeInstanceId: 'tee-1',
      codeHash: 'code-1',
      attestation: 'att-1',
      endpoint: 'http://agent:3000',
    });

    const result = await registry.deactivateAgent('tee-wrong');
    expect(result.success).toBe(false);
  });

  it('isRegistered returns correct status', async () => {
    expect(await registry.isRegistered('tee-1')).toBe(false);

    await registry.registerAgent({
      teeInstanceId: 'tee-1',
      codeHash: 'code-1',
      attestation: 'att-1',
      endpoint: 'http://agent:3000',
    });

    expect(await registry.isRegistered('tee-1')).toBe(true);
    expect(await registry.isRegistered('tee-2')).toBe(false);

    await registry.deactivateAgent('tee-1');
    expect(await registry.isRegistered('tee-1')).toBe(false);
  });
});
