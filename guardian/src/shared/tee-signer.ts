/**
 * TEE Signing Client — abstracts SecretVM ed25519 signing and X25519 key exchange.
 *
 * In production (SecretVM): calls POST /sign endpoint for ed25519 signatures,
 * loads public key from mounted PEM file, generates X25519 keypair for ECDH.
 *
 * In development: generates an ed25519 keypair in-memory using Node.js crypto.
 */
import {
  generateKeyPairSync,
  createPublicKey,
  createPrivateKey,
  sign,
  verify,
  randomBytes,
  diffieHellman,
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

// ── SecretVM Signer (Production) ─────────────────────────────────

const SECRETVM_SIGN_ENDPOINT = process.env.SECRETVM_SIGN_ENDPOINT ?? 'http://172.17.0.1:49153/sign';
const SECRETVM_PUBKEY_PEM_PATH = process.env.SECRETVM_PUBKEY_PEM_PATH ?? '/mnt/secure/docker_public_key_ed25519.pem';
const SECRETVM_ATTESTATION_PATH = process.env.SECRETVM_ATTESTATION_PATH ?? '/mnt/secure/docker_attestation_ed25519.txt';

async function signViaSecretVM(data: string | Buffer): Promise<string> {
  const payload = typeof data === 'string' ? data : data.toString('base64');
  const res = await fetch(SECRETVM_SIGN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key_type: 'ed25519', payload }),
    signal: AbortSignal.timeout(5_000),
  });

  if (!res.ok) {
    throw new Error(`SecretVM /sign failed: ${res.status} ${res.statusText}`);
  }

  const result = await res.json() as { signature: string };
  return result.signature;
}

function loadEd25519PubkeyFromPEM(pemPath: string): Buffer {
  const pem = readFileSync(pemPath, 'utf-8');
  const keyObj = createPublicKey(pem);
  // Export as raw 32-byte ed25519 public key
  return keyObj.export({ type: 'spki', format: 'der' }).subarray(-32);
}

/** Read the attestation quote from the mounted file. */
export function loadAttestationQuote(path?: string): string | null {
  const p = path ?? SECRETVM_ATTESTATION_PATH;
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf-8').trim();
}

// ── Dev Signer (Local Development) ───────────────────────────────

function createDevEd25519(): { privateKey: KeyObject; publicKey: KeyObject; pubkeyRaw: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubkeyRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { privateKey, publicKey, pubkeyRaw };
}

// ── X25519 Keypair (used in both modes) ──────────────────────────

function createX25519Keypair(): { privateKey: KeyObject; publicKey: KeyObject; pubkeyRaw: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const pubkeyRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { privateKey, publicKey, pubkeyRaw };
}

function computeECDH(myPrivateKey: KeyObject, peerPubkeyRaw: Buffer): Buffer {
  const peerPubObj = createPublicKey({
    key: Buffer.concat([
      // X25519 SPKI header (12 bytes) + 32 byte key
      Buffer.from('302a300506032b656e032100', 'hex'),
      peerPubkeyRaw,
    ]),
    format: 'der',
    type: 'spki',
  });
  return diffieHellman({ privateKey: myPrivateKey, publicKey: peerPubObj });
}

// ── Factory ──────────────────────────────────────────────────────

/**
 * Detect whether we're running in SecretVM and create the appropriate signer.
 */
export async function createTEESigner(): Promise<TEESigner> {
  const isSecretVM = existsSync(SECRETVM_PUBKEY_PEM_PATH);

  if (isSecretVM) {
    try {
      return await createSecretVMSigner();
    } catch (err) {
      console.warn(`[TEESigner] SecretVM signing failed, falling back to dev signer: ${err instanceof Error ? err.message : err}`);
      return createDevSigner();
    }
  }
  return createDevSigner();
}

async function createSecretVMSigner(): Promise<TEESigner> {
  // Load ed25519 pubkey from PEM
  const ed25519PubkeyRaw = loadEd25519PubkeyFromPEM(SECRETVM_PUBKEY_PEM_PATH);
  const ed25519PubkeyBase64 = ed25519PubkeyRaw.toString('base64');

  // Generate X25519 keypair for ECDH
  const x25519 = createX25519Keypair();
  const x25519PubkeyBase64 = x25519.pubkeyRaw.toString('base64');

  // Sign X25519 pubkey with ed25519 to prove they belong to the same TEE
  const x25519Signature = await signViaSecretVM(x25519.pubkeyRaw);

  return {
    ed25519PubkeyBase64,
    x25519PubkeyBase64,
    x25519Signature,
    isProduction: true,

    async sign(data: string | Buffer): Promise<string> {
      return signViaSecretVM(data);
    },

    verify(data: string | Buffer, signature: string, pubkeyBase64: string): boolean {
      return verifyEd25519(data, signature, pubkeyBase64);
    },

    ecdh(peerX25519PubkeyBase64: string): Buffer {
      const peerPubkey = Buffer.from(peerX25519PubkeyBase64, 'base64');
      return computeECDH(x25519.privateKey, peerPubkey);
    },
  };
}

export function createDevSigner(): TEESigner {
  const ed25519 = createDevEd25519();
  const ed25519PubkeyBase64 = ed25519.pubkeyRaw.toString('base64');

  const x25519 = createX25519Keypair();
  const x25519PubkeyBase64 = x25519.pubkeyRaw.toString('base64');

  // Sign X25519 pubkey with ed25519 (local).
  // Sign the base64 string (as UTF-8 bytes) to match SecretVM behavior:
  // SecretVM signs the base64 payload string, and the verifier checks
  // against Buffer.from(base64String) which is also UTF-8 of base64.
  const x25519SigBuf = sign(null, Buffer.from(x25519PubkeyBase64), ed25519.privateKey);
  const x25519Signature = x25519SigBuf.toString('base64');

  return {
    ed25519PubkeyBase64,
    x25519PubkeyBase64,
    x25519Signature,
    isProduction: false,

    async sign(data: string | Buffer): Promise<string> {
      const buf = typeof data === 'string' ? Buffer.from(data) : data;
      return sign(null, buf, ed25519.privateKey).toString('base64');
    },

    verify(data: string | Buffer, signature: string, pubkeyBase64: string): boolean {
      return verifyEd25519(data, signature, pubkeyBase64);
    },

    ecdh(peerX25519PubkeyBase64: string): Buffer {
      const peerPubkey = Buffer.from(peerX25519PubkeyBase64, 'base64');
      return computeECDH(x25519.privateKey, peerPubkey);
    },
  };
}

// ── Shared Verification ──────────────────────────────────────────

function verifyEd25519(data: string | Buffer, signature: string, pubkeyBase64: string): boolean {
  try {
    const pubkeyRaw = Buffer.from(pubkeyBase64, 'base64');
    const pubkeyObj = createPublicKey({
      key: Buffer.concat([
        // ed25519 SPKI header (12 bytes) + 32 byte key
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
