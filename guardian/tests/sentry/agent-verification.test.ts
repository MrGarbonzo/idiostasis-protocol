import { describe, it, expect, beforeEach } from 'vitest';
import { LocalRegistryClient } from '../../src/shared/registry-client.js';
import {
  generateAttestation,
  serializeAttestation,
} from '../../src/shared/attestation.js';
import {
  AgentVerifier,
  createApprovedCodeSet,
} from '../../src/sentry/agent-verification.js';

describe('AgentVerifier', () => {
  let registry: LocalRegistryClient;
  let verifier: AgentVerifier;
  const TEE_ID = 'test-tee-001';
  const CODE_HASH = 'approved-code-hash';

  beforeEach(async () => {
    registry = new LocalRegistryClient();
    const approved = createApprovedCodeSet([CODE_HASH]);
    verifier = new AgentVerifier(registry, approved);

    // Register an agent
    await registry.registerAgent({
      teeInstanceId: TEE_ID,
      codeHash: CODE_HASH,
      attestation: '',
      endpoint: 'http://agent:3000',
    });
  });

  it('verifies a legitimate agent', async () => {
    const att = generateAttestation(TEE_ID, CODE_HASH);
    const attStr = serializeAttestation(att);

    const result = await verifier.verifyAgent(TEE_ID, attStr);
    expect(result.verified).toBe(true);
    expect(result.agentRecord).not.toBeNull();
  });

  it('rejects wrong TEE instance ID', async () => {
    const att = generateAttestation('wrong-tee', CODE_HASH);
    const attStr = serializeAttestation(att);

    const result = await verifier.verifyAgent('wrong-tee', attStr);
    expect(result.verified).toBe(false);
    expect(result.error).toContain('TEE instance mismatch');
  });

  it('rejects unapproved code hash', async () => {
    const approvedStrict = createApprovedCodeSet(['only-this-hash']);
    const strictVerifier = new AgentVerifier(registry, approvedStrict);

    const att = generateAttestation(TEE_ID, CODE_HASH); // CODE_HASH not in strict set
    const attStr = serializeAttestation(att);

    const result = await strictVerifier.verifyAgent(TEE_ID, attStr);
    expect(result.verified).toBe(false);
    expect(result.error).toContain('Code hash not approved');
  });

  it('rejects when no agent registered', async () => {
    const emptyRegistry = new LocalRegistryClient();
    const v = new AgentVerifier(emptyRegistry, createApprovedCodeSet());

    const att = generateAttestation(TEE_ID, CODE_HASH);
    const attStr = serializeAttestation(att);

    const result = await v.verifyAgent(TEE_ID, attStr);
    expect(result.verified).toBe(false);
    expect(result.error).toContain('No agent registered');
  });

  it('rejects inactive agent', async () => {
    await registry.deactivateAgent(TEE_ID);

    const att = generateAttestation(TEE_ID, CODE_HASH);
    const attStr = serializeAttestation(att);

    const result = await verifier.verifyAgent(TEE_ID, attStr);
    expect(result.verified).toBe(false);
    expect(result.error).toContain('not active');
  });

  it('rejects invalid attestation format', async () => {
    const result = await verifier.verifyAgent(TEE_ID, 'not-base64-json');
    expect(result.verified).toBe(false);
    expect(result.error).toContain('Invalid attestation');
  });

  it('processes heartbeat for registered agent', async () => {
    const att = generateAttestation(TEE_ID, CODE_HASH);
    const result = await verifier.processHeartbeat({
      teeInstanceId: TEE_ID,
      attestation: serializeAttestation(att),
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it('rejects heartbeat for unregistered agent', async () => {
    const att = generateAttestation('unknown-tee', CODE_HASH);
    const result = await verifier.processHeartbeat({
      teeInstanceId: 'unknown-tee',
      attestation: serializeAttestation(att),
      timestamp: Date.now(),
    });
    expect(result.success).toBe(false);
  });

  it('checkHealth reports healthy agent', async () => {
    // Send a fresh heartbeat
    await registry.heartbeat({
      teeInstanceId: TEE_ID,
      attestation: '',
      timestamp: Date.now(),
    });

    const result = await verifier.checkHealth();
    expect(result.healthy).toBe(true);
    expect(result.deactivated).toBe(false);
  });

  it('getCurrentAgent returns the active agent', async () => {
    const agent = await verifier.getCurrentAgent();
    expect(agent).not.toBeNull();
    expect(agent!.teeInstanceId).toBe(TEE_ID);
  });
});

describe('ApprovedCode', () => {
  it('empty set approves everything', () => {
    const approved = createApprovedCodeSet();
    expect(approved.isApproved('any-hash')).toBe(true);
  });

  it('non-empty set only approves listed hashes', () => {
    const approved = createApprovedCodeSet(['hash-a', 'hash-b']);
    expect(approved.isApproved('hash-a')).toBe(true);
    expect(approved.isApproved('hash-b')).toBe(true);
    expect(approved.isApproved('hash-c')).toBe(false);
  });

  it('approve and revoke work', () => {
    const approved = createApprovedCodeSet(['hash-a']);
    expect(approved.isApproved('hash-b')).toBe(false);

    approved.approve('hash-b');
    expect(approved.isApproved('hash-b')).toBe(true);

    approved.revoke('hash-a');
    expect(approved.isApproved('hash-a')).toBe(false);
  });
});
