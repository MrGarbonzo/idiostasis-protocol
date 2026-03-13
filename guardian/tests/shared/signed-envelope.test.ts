import { describe, it, expect, beforeEach } from 'vitest';
import { createDevSigner } from '../../src/shared/tee-signer.js';
import {
  createEnvelope,
  verifyEnvelope,
  parsePayload,
  buildCanonicalString,
  hashPayload,
  NonceTracker,
  type SignedEnvelope,
} from '../../src/shared/signed-envelope.js';
import type { TEESigner } from '../../src/shared/tee-signer.js';

describe('SignedEnvelope', () => {
  let signer: TEESigner;

  beforeEach(() => {
    signer = createDevSigner();
  });

  describe('createEnvelope', () => {
    it('creates a valid envelope', async () => {
      const envelope = await createEnvelope({
        sender: 'guardian-1',
        action: 'heartbeat',
        payload: { status: 'ok', timestamp: Date.now() },
        signer,
      });

      expect(envelope.version).toBe(1);
      expect(envelope.sender).toBe('guardian-1');
      expect(envelope.action).toBe('heartbeat');
      expect(envelope.timestamp).toBeGreaterThan(0);
      expect(envelope.nonce).toHaveLength(32); // 16 bytes hex
      expect(envelope.payloadHash).toHaveLength(64); // SHA-256 hex
      expect(envelope.signature).toBeTruthy();
      expect(typeof envelope.payload).toBe('string');
    });

    it('payload is valid JSON', async () => {
      const data = { key: 'value', num: 42 };
      const envelope = await createEnvelope({
        sender: 'node-a',
        action: 'peer.announce',
        payload: data,
        signer,
      });

      const parsed = JSON.parse(envelope.payload);
      expect(parsed).toEqual(data);
    });
  });

  describe('verifyEnvelope', () => {
    it('verifies a valid envelope', async () => {
      const envelope = await createEnvelope({
        sender: 'guardian-1',
        action: 'heartbeat',
        payload: { status: 'ok' },
        signer,
      });

      const result = verifyEnvelope({
        envelope,
        senderPubkeyBase64: signer.ed25519PubkeyBase64,
        signer,
      });

      expect(result.valid).toBe(true);
      expect(result.sender).toBe('guardian-1');
      expect(result.action).toBe('heartbeat');
    });

    it('rejects wrong version', async () => {
      const envelope = await createEnvelope({
        sender: 'node-a',
        action: 'heartbeat',
        payload: {},
        signer,
      });
      (envelope as { version: number }).version = 2;

      const result = verifyEnvelope({
        envelope,
        senderPubkeyBase64: signer.ed25519PubkeyBase64,
        signer,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unsupported version');
    });

    it('rejects expired message', async () => {
      const envelope = await createEnvelope({
        sender: 'node-a',
        action: 'heartbeat',
        payload: {},
        signer,
      });
      // Set timestamp to 10 minutes ago
      envelope.timestamp = Date.now() - 10 * 60 * 1000;

      const result = verifyEnvelope({
        envelope,
        senderPubkeyBase64: signer.ed25519PubkeyBase64,
        signer,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('too old');
    });

    it('rejects future message', async () => {
      const envelope = await createEnvelope({
        sender: 'node-a',
        action: 'heartbeat',
        payload: {},
        signer,
      });
      // Set timestamp 2 minutes in the future
      envelope.timestamp = Date.now() + 2 * 60 * 1000;

      const result = verifyEnvelope({
        envelope,
        senderPubkeyBase64: signer.ed25519PubkeyBase64,
        signer,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('future');
    });

    it('rejects replay (duplicate nonce)', async () => {
      const tracker = new NonceTracker();
      const envelope = await createEnvelope({
        sender: 'node-a',
        action: 'heartbeat',
        payload: {},
        signer,
      });

      // First check passes
      const result1 = verifyEnvelope({
        envelope,
        senderPubkeyBase64: signer.ed25519PubkeyBase64,
        signer,
        nonceTracker: tracker,
      });
      expect(result1.valid).toBe(true);

      // Second check fails (replay)
      const result2 = verifyEnvelope({
        envelope,
        senderPubkeyBase64: signer.ed25519PubkeyBase64,
        signer,
        nonceTracker: tracker,
      });
      expect(result2.valid).toBe(false);
      expect(result2.error).toContain('replay');
    });

    it('rejects tampered payload', async () => {
      const envelope = await createEnvelope({
        sender: 'node-a',
        action: 'heartbeat',
        payload: { original: true },
        signer,
      });

      // Tamper with payload but keep hash
      envelope.payload = JSON.stringify({ tampered: true });

      const result = verifyEnvelope({
        envelope,
        senderPubkeyBase64: signer.ed25519PubkeyBase64,
        signer,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Payload hash mismatch');
    });

    it('rejects wrong sender pubkey', async () => {
      const otherSigner = createDevSigner();
      const envelope = await createEnvelope({
        sender: 'node-a',
        action: 'heartbeat',
        payload: {},
        signer,
      });

      const result = verifyEnvelope({
        envelope,
        senderPubkeyBase64: otherSigner.ed25519PubkeyBase64,
        signer,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid signature');
    });

    it('rejects tampered signature', async () => {
      const envelope = await createEnvelope({
        sender: 'node-a',
        action: 'heartbeat',
        payload: {},
        signer,
      });
      envelope.signature = 'AAAA' + envelope.signature.substring(4);

      const result = verifyEnvelope({
        envelope,
        senderPubkeyBase64: signer.ed25519PubkeyBase64,
        signer,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid signature');
    });

    it('allows custom maxAgeMs', async () => {
      // A freshly created envelope should pass with a generous window
      const envelope = await createEnvelope({
        sender: 'node-a',
        action: 'heartbeat',
        payload: {},
        signer,
      });

      // Accept with 10s max age (envelope is fresh)
      const accept = verifyEnvelope({
        envelope,
        senderPubkeyBase64: signer.ed25519PubkeyBase64,
        signer,
        maxAgeMs: 10_000,
      });
      expect(accept.valid).toBe(true);

      // Reject with -1ms max age (even a fresh envelope is "too old")
      const reject = verifyEnvelope({
        envelope,
        senderPubkeyBase64: signer.ed25519PubkeyBase64,
        signer,
        maxAgeMs: -1,
      });
      expect(reject.valid).toBe(false);
      expect(reject.error).toContain('too old');
    });
  });

  describe('parsePayload', () => {
    it('parses typed payload from envelope', async () => {
      interface TestPayload { key: string; num: number }

      const envelope = await createEnvelope({
        sender: 'node-a',
        action: 'heartbeat',
        payload: { key: 'value', num: 42 },
        signer,
      });

      const parsed = parsePayload<TestPayload>(envelope);
      expect(parsed.key).toBe('value');
      expect(parsed.num).toBe(42);
    });
  });

  describe('buildCanonicalString', () => {
    it('produces deterministic output', () => {
      const s1 = buildCanonicalString('node-a', 1234567890, 'abc123', 'heartbeat', 'hash456');
      const s2 = buildCanonicalString('node-a', 1234567890, 'abc123', 'heartbeat', 'hash456');
      expect(s1).toBe(s2);
      expect(s1).toBe('v1|node-a|1234567890|abc123|heartbeat|hash456');
    });
  });

  describe('hashPayload', () => {
    it('produces consistent SHA-256 hashes', () => {
      const h1 = hashPayload('{"key":"value"}');
      const h2 = hashPayload('{"key":"value"}');
      expect(h1).toBe(h2);
      expect(h1).toHaveLength(64);
    });

    it('different payloads produce different hashes', () => {
      const h1 = hashPayload('{"a":1}');
      const h2 = hashPayload('{"b":2}');
      expect(h1).not.toBe(h2);
    });
  });

  describe('NonceTracker', () => {
    it('accepts new nonces', () => {
      const tracker = new NonceTracker();
      expect(tracker.check('nonce-1')).toBe(true);
      expect(tracker.check('nonce-2')).toBe(true);
      expect(tracker.check('nonce-3')).toBe(true);
    });

    it('rejects duplicate nonces', () => {
      const tracker = new NonceTracker();
      expect(tracker.check('nonce-1')).toBe(true);
      expect(tracker.check('nonce-1')).toBe(false);
    });

    it('evicts oldest nonces when full', () => {
      const tracker = new NonceTracker(3);
      expect(tracker.check('a')).toBe(true);
      expect(tracker.check('b')).toBe(true);
      expect(tracker.check('c')).toBe(true);
      expect(tracker.size).toBe(3);

      // Adding a 4th should evict 'a'
      expect(tracker.check('d')).toBe(true);
      expect(tracker.size).toBe(3);

      // 'a' was evicted, so it's accepted again
      expect(tracker.check('a')).toBe(true);
      // 'b' might still be there or evicted
    });

    it('tracks size correctly', () => {
      const tracker = new NonceTracker();
      expect(tracker.size).toBe(0);
      tracker.check('a');
      expect(tracker.size).toBe(1);
      tracker.check('a'); // duplicate
      expect(tracker.size).toBe(1);
      tracker.check('b');
      expect(tracker.size).toBe(2);
    });
  });
});
