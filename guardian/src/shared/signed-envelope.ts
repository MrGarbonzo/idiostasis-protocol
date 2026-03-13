/**
 * Signed Envelope — wraps every message between nodes with ed25519 signatures.
 *
 * Provides:
 * - Message authenticity (ed25519 signature via TEE)
 * - Replay protection (nonce tracking + timestamp window)
 * - Integrity (SHA-256 payload hash)
 * - Deterministic canonical signing string
 */
import { createHash, randomBytes } from 'node:crypto';
import type { TEESigner } from './tee-signer.js';

// ── Types ────────────────────────────────────────────────────────

export interface SignedEnvelope {
  /** Protocol version. */
  version: 1;
  /** Sender's node identifier (guardian address or TEE instance ID). */
  sender: string;
  /** Unix timestamp in milliseconds. */
  timestamp: number;
  /** 16 random bytes (hex) — prevents replay attacks. */
  nonce: string;
  /** Message type (see action catalog). */
  action: string;
  /** SHA-256 hash of the payload field. */
  payloadHash: string;
  /** JSON-stringified payload (or base64 for binary data). */
  payload: string;
  /** ed25519 signature (base64) over the canonical signing string. */
  signature: string;
}

export type EnvelopeAction =
  | 'attest.request'
  | 'attest.response'
  | 'db.snapshot'
  | 'db.recovery.request'
  | 'db.recovery.response'
  | 'heartbeat'
  | 'peer.announce'
  | 'proposal.create'
  | 'vote.cast'
  | 'health.report'
  | 'vault.rotate';

export interface EnvelopeVerifyResult {
  valid: boolean;
  sender: string;
  action: string;
  timestamp: number;
  error?: string;
}

// ── Constants ────────────────────────────────────────────────────

/** Maximum age of a message before it's rejected (5 minutes). */
const MAX_AGE_MS = 5 * 60 * 1000;

/** Maximum future drift allowed (30 seconds). */
const MAX_FUTURE_DRIFT_MS = 30 * 1000;

/** Default nonce cache size (how many nonces to remember). */
const DEFAULT_NONCE_CACHE_SIZE = 10_000;

// ── Nonce Tracker ────────────────────────────────────────────────

export class NonceTracker {
  private seen: Set<string>;
  private order: string[];
  private maxSize: number;

  constructor(maxSize = DEFAULT_NONCE_CACHE_SIZE) {
    this.seen = new Set();
    this.order = [];
    this.maxSize = maxSize;
  }

  /** Returns true if nonce is new (not seen before). */
  check(nonce: string): boolean {
    if (this.seen.has(nonce)) return false;

    this.seen.add(nonce);
    this.order.push(nonce);

    // Evict oldest when cache is full
    while (this.order.length > this.maxSize) {
      const oldest = this.order.shift()!;
      this.seen.delete(oldest);
    }

    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

// ── Canonical String ─────────────────────────────────────────────

/**
 * Build the deterministic canonical signing string.
 * Format: v1|{sender}|{timestamp}|{nonce}|{action}|{payloadHash}
 */
export function buildCanonicalString(
  sender: string,
  timestamp: number,
  nonce: string,
  action: string,
  payloadHash: string,
): string {
  return `v1|${sender}|${timestamp}|${nonce}|${action}|${payloadHash}`;
}

/**
 * Compute SHA-256 hash of a payload string.
 */
export function hashPayload(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

// ── Envelope Creation ────────────────────────────────────────────

export interface CreateEnvelopeOptions {
  sender: string;
  action: EnvelopeAction | string;
  payload: unknown;
  signer: TEESigner;
}

/**
 * Create a signed envelope wrapping the given payload.
 */
export async function createEnvelope(opts: CreateEnvelopeOptions): Promise<SignedEnvelope> {
  const { sender, action, payload, signer } = opts;

  const timestamp = Date.now();
  const nonce = randomBytes(16).toString('hex');
  const payloadStr = JSON.stringify(payload);
  const payloadHash = hashPayload(payloadStr);

  const canonical = buildCanonicalString(sender, timestamp, nonce, action, payloadHash);
  const signature = await signer.sign(canonical);

  return {
    version: 1,
    sender,
    timestamp,
    nonce,
    action,
    payloadHash,
    payload: payloadStr,
    signature,
  };
}

// ── Envelope Verification ────────────────────────────────────────

export interface VerifyEnvelopeOptions {
  envelope: SignedEnvelope;
  /** Sender's known ed25519 public key (base64). Required to verify signature. */
  senderPubkeyBase64: string;
  /** TEE signer to use for verification (uses its verify method). */
  signer: TEESigner;
  /** Nonce tracker for replay protection. If omitted, nonce replay is not checked. */
  nonceTracker?: NonceTracker;
  /** Custom max age in ms. Defaults to 5 minutes. */
  maxAgeMs?: number;
}

/**
 * Verify a signed envelope's integrity, freshness, and authenticity.
 */
export function verifyEnvelope(opts: VerifyEnvelopeOptions): EnvelopeVerifyResult {
  const { envelope, senderPubkeyBase64, signer, nonceTracker, maxAgeMs } = opts;

  const base: EnvelopeVerifyResult = {
    valid: false,
    sender: envelope.sender,
    action: envelope.action,
    timestamp: envelope.timestamp,
  };

  // 1. Check version
  if (envelope.version !== 1) {
    return { ...base, error: `Unsupported version: ${envelope.version}` };
  }

  // 2. Check timestamp window
  const now = Date.now();
  const age = now - envelope.timestamp;
  const maxAge = maxAgeMs ?? MAX_AGE_MS;

  if (age > maxAge) {
    return { ...base, error: `Message too old: ${Math.floor(age / 1000)}s` };
  }
  if (age < -MAX_FUTURE_DRIFT_MS) {
    return { ...base, error: `Message from the future: ${Math.floor(-age / 1000)}s ahead` };
  }

  // 3. Check nonce uniqueness (replay protection)
  if (nonceTracker && !nonceTracker.check(envelope.nonce)) {
    return { ...base, error: 'Duplicate nonce (replay detected)' };
  }

  // 4. Verify payload hash
  const computedHash = hashPayload(envelope.payload);
  if (computedHash !== envelope.payloadHash) {
    return { ...base, error: 'Payload hash mismatch' };
  }

  // 5. Verify signature
  const canonical = buildCanonicalString(
    envelope.sender,
    envelope.timestamp,
    envelope.nonce,
    envelope.action,
    envelope.payloadHash,
  );

  const sigValid = signer.verify(canonical, envelope.signature, senderPubkeyBase64);
  if (!sigValid) {
    return { ...base, error: 'Invalid signature' };
  }

  return { ...base, valid: true };
}

/**
 * Parse the payload from a verified envelope.
 */
export function parsePayload<T>(envelope: SignedEnvelope): T {
  return JSON.parse(envelope.payload) as T;
}
