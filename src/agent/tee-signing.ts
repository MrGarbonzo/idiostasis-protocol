/**
 * TEE Signing Client — agent-side wrapper for SecretVM ed25519 signing.
 *
 * Mirrors guardian-network's tee-signer.ts but adapted for the agent context.
 * Provides the same TEESigner interface for creating signed envelopes.
 */
import {
  generateKeyPairSync,
  createPublicKey,
  sign,
  verify,
  randomBytes,
  diffieHellman,
  createHash,
  createCipheriv,
  createDecipheriv,
  type KeyObject,
} from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

// ── Types ────────────────────────────────────────────────────────

export interface TEESigner {
  /** This node's ed25519 public key (base64, raw 32 bytes). */
  readonly ed25519PubkeyBase64: string;
  /** This node's X25519 public key (base64, raw 32 bytes). */
  readonly x25519PubkeyBase64: string;
  /** ed25519 signature over the X25519 public key (proves same TEE). */
  readonly x25519Signature: string;
  /** Sign arbitrary data with ed25519. Returns base64 signature. */
  sign(data: string | Buffer): Promise<string>;
  /** Verify an ed25519 signature against a known public key. */
  verify(data: string | Buffer, signature: string, pubkeyBase64: string): boolean;
  /** Compute X25519 ECDH shared secret with a peer's X25519 public key. */
  ecdh(peerX25519PubkeyBase64: string): Buffer;
  /** Whether this signer is using real SecretVM hardware. */
  readonly isProduction: boolean;
}

export interface SignedEnvelope {
  version: 1;
  sender: string;
  timestamp: number;
  nonce: string;
  action: string;
  payloadHash: string;
  payload: string;
  signature: string;
}

// ── Constants ────────────────────────────────────────────────────

const SECRETVM_SIGN_ENDPOINT = process.env.SECRETVM_SIGN_ENDPOINT ?? 'http://172.17.0.1:49153/sign';
const SECRETVM_PUBKEY_PEM_PATH = process.env.SECRETVM_PUBKEY_PEM_PATH ?? '/mnt/secure/docker_public_key_ed25519.pem';
const SECRETVM_ATTESTATION_PATH = process.env.SECRETVM_ATTESTATION_PATH ?? '/mnt/secure/docker_attestation_ed25519.txt';

// ── SecretVM Signer ──────────────────────────────────────────────

async function signViaSecretVM(data: string | Buffer): Promise<string> {
  const payload = typeof data === 'string' ? data : data.toString('base64');
  const res = await fetch(SECRETVM_SIGN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key_type: 'ed25519', payload }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`SecretVM /sign failed: ${res.status}`);
  const result = await res.json() as { signature: string };
  return result.signature;
}

function loadEd25519PubkeyFromPEM(pemPath: string): Buffer {
  const pem = readFileSync(pemPath, 'utf-8');
  const keyObj = createPublicKey(pem);
  return keyObj.export({ type: 'spki', format: 'der' }).subarray(-32);
}

/** Read the attestation quote from the mounted file. */
export function loadAttestationQuote(path?: string): string | null {
  const p = path ?? SECRETVM_ATTESTATION_PATH;
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf-8').trim();
}

// ── Keypair Generation ───────────────────────────────────────────

function createX25519Keypair(): { privateKey: KeyObject; pubkeyRaw: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const pubkeyRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { privateKey, pubkeyRaw };
}

function computeECDH(myPrivateKey: KeyObject, peerPubkeyRaw: Buffer): Buffer {
  const peerPubObj = createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b656e032100', 'hex'),
      peerPubkeyRaw,
    ]),
    format: 'der',
    type: 'spki',
  });
  return diffieHellman({ privateKey: myPrivateKey, publicKey: peerPubObj });
}

function verifyEd25519(data: string | Buffer, signature: string, pubkeyBase64: string): boolean {
  try {
    const pubkeyRaw = Buffer.from(pubkeyBase64, 'base64');
    const pubkeyObj = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        pubkeyRaw,
      ]),
      format: 'der',
      type: 'spki',
    });
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    const sigBuf = Buffer.from(signature, 'base64');
    return verify(null, buf, pubkeyObj, sigBuf);
  } catch {
    return false;
  }
}

// ── Factory ──────────────────────────────────────────────────────

/**
 * Create a TEE signer. Auto-detects SecretVM vs dev mode.
 */
export async function createTEESigner(): Promise<TEESigner> {
  const isSecretVM = existsSync(SECRETVM_PUBKEY_PEM_PATH);

  if (isSecretVM) {
    try {
      const ed25519PubkeyRaw = loadEd25519PubkeyFromPEM(SECRETVM_PUBKEY_PEM_PATH);
      const ed25519PubkeyBase64 = ed25519PubkeyRaw.toString('base64');
      const x25519 = createX25519Keypair();
      const x25519PubkeyBase64 = x25519.pubkeyRaw.toString('base64');
      const x25519Signature = await signViaSecretVM(x25519.pubkeyRaw);

      return {
        ed25519PubkeyBase64,
        x25519PubkeyBase64,
        x25519Signature,
        isProduction: true,
        async sign(data) { return signViaSecretVM(data); },
        verify: verifyEd25519,
        ecdh(peerPub) { return computeECDH(x25519.privateKey, Buffer.from(peerPub, 'base64')); },
      };
    } catch (err) {
      console.warn(`[tee-signing] SecretVM PEM/signing failed, falling back to dev mode: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Dev mode
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const ed25519PubkeyRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const ed25519PubkeyBase64 = ed25519PubkeyRaw.toString('base64');
  const x25519 = createX25519Keypair();
  const x25519PubkeyBase64 = x25519.pubkeyRaw.toString('base64');
  // Sign the base64 string (as UTF-8 bytes) to match SecretVM behavior:
  // SecretVM signs the base64 payload string, and the verifier checks
  // against Buffer.from(base64String) which is also UTF-8 of base64.
  const x25519SigBuf = sign(null, Buffer.from(x25519PubkeyBase64), privateKey);
  const x25519Signature = x25519SigBuf.toString('base64');

  return {
    ed25519PubkeyBase64,
    x25519PubkeyBase64,
    x25519Signature,
    isProduction: false,
    async sign(data) {
      const buf = typeof data === 'string' ? Buffer.from(data) : data;
      return sign(null, buf, privateKey).toString('base64');
    },
    verify: verifyEd25519,
    ecdh(peerPub) { return computeECDH(x25519.privateKey, Buffer.from(peerPub, 'base64')); },
  };
}

// ── Envelope Helpers ─────────────────────────────────────────────

function hashPayload(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Create a signed envelope wrapping a payload.
 */
export async function createEnvelope(
  sender: string,
  action: string,
  payload: unknown,
  signer: TEESigner,
): Promise<SignedEnvelope> {
  const timestamp = Date.now();
  const nonce = randomBytes(16).toString('hex');
  const payloadStr = JSON.stringify(payload);
  const payloadHash = hashPayload(payloadStr);
  const canonical = `v1|${sender}|${timestamp}|${nonce}|${action}|${payloadHash}`;
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

// ── Vault Key Encryption Helpers ─────────────────────────────────

/**
 * Encrypt data with AES-256-GCM.
 */
export function aesEncrypt(key: Buffer, plaintext: Buffer): {
  ciphertext: string; iv: string; authTag: string;
} {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
  };
}

/**
 * Decrypt data with AES-256-GCM.
 */
export function aesDecrypt(key: Buffer, data: { ciphertext: string; iv: string; authTag: string }): Buffer {
  const iv = Buffer.from(data.iv, 'hex');
  const authTag = Buffer.from(data.authTag, 'hex');
  const ciphertext = Buffer.from(data.ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
