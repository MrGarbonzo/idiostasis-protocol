import { describe, it, expect } from 'vitest';
import {
  generateAttestation,
  verifyAttestation,
  serializeAttestation,
  deserializeAttestation,
  computeCodeHash,
} from '../../src/shared/attestation.js';

describe('Attestation', () => {
  const TEE_ID = 'test-tee-instance-001';
  const CODE_HASH = 'abc123def456789';
  const SECRET = 'dev-attestation-secret';

  it('generates a valid attestation', () => {
    const att = generateAttestation(TEE_ID, CODE_HASH);
    expect(att.teeInstanceId).toBe(TEE_ID);
    expect(att.codeHash).toBe(CODE_HASH);
    expect(att.timestamp).toBeGreaterThan(0);
    expect(att.nonce).toHaveLength(32); // 16 bytes hex
    expect(att.signature).toHaveLength(64); // sha256 hex
  });

  it('verifies a valid attestation', () => {
    const att = generateAttestation(TEE_ID, CODE_HASH, SECRET);
    const result = verifyAttestation(att, { signingSecret: SECRET });
    expect(result.valid).toBe(true);
    expect(result.teeInstanceId).toBe(TEE_ID);
    expect(result.codeHash).toBe(CODE_HASH);
  });

  it('rejects tampered attestation', () => {
    const att = generateAttestation(TEE_ID, CODE_HASH, SECRET);
    att.codeHash = 'tampered-hash';
    const result = verifyAttestation(att, { signingSecret: SECRET });
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid signature');
  });

  it('rejects wrong signing secret', () => {
    const att = generateAttestation(TEE_ID, CODE_HASH, SECRET);
    const result = verifyAttestation(att, { signingSecret: 'wrong-secret' });
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid signature');
  });

  it('rejects expired attestation', () => {
    const att = generateAttestation(TEE_ID, CODE_HASH, SECRET);
    att.timestamp = Date.now() - 600_000; // 10 minutes ago
    // Re-sign with correct timestamp
    // Actually we need to regenerate since the signature covers the old timestamp
    // So let's test with maxAgeSeconds = 0 to force rejection
    const fresh = generateAttestation(TEE_ID, CODE_HASH, SECRET);
    // Manually set old timestamp (signature will be wrong for this timestamp)
    // Instead, let's use a very small maxAgeSeconds
    const result = verifyAttestation(fresh, {
      signingSecret: SECRET,
      maxAgeSeconds: 0, // Immediately expired
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('too old');
  });

  it('rejects code hash mismatch', () => {
    const att = generateAttestation(TEE_ID, CODE_HASH, SECRET);
    const result = verifyAttestation(att, {
      signingSecret: SECRET,
      expectedCodeHash: 'different-hash',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Code hash mismatch');
  });

  it('accepts matching code hash', () => {
    const att = generateAttestation(TEE_ID, CODE_HASH, SECRET);
    const result = verifyAttestation(att, {
      signingSecret: SECRET,
      expectedCodeHash: CODE_HASH,
    });
    expect(result.valid).toBe(true);
  });

  it('serializes and deserializes round-trip', () => {
    const att = generateAttestation(TEE_ID, CODE_HASH);
    const encoded = serializeAttestation(att);
    expect(typeof encoded).toBe('string');

    const decoded = deserializeAttestation(encoded);
    expect(decoded.teeInstanceId).toBe(TEE_ID);
    expect(decoded.codeHash).toBe(CODE_HASH);
    expect(decoded.timestamp).toBe(att.timestamp);
    expect(decoded.nonce).toBe(att.nonce);
    expect(decoded.signature).toBe(att.signature);
  });

  it('computeCodeHash is deterministic', () => {
    const hash1 = computeCodeHash('hello world');
    const hash2 = computeCodeHash('hello world');
    const hash3 = computeCodeHash('different');
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash1).toHaveLength(64);
  });
});
