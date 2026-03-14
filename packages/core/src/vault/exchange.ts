import {
  generateKeyPairSync,
  diffieHellman,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createPublicKey,
  sign,
  KeyObject,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';

export interface WrappedKey {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export interface PublicKeys {
  x25519: Uint8Array;
  ed25519: Uint8Array;
  signature: Uint8Array;
}

/** X25519 SPKI prefix (12 bytes) for wrapping raw 32-byte public keys. */
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

/**
 * A single key exchange session (spec Section 6).
 * Generates X25519 keypair, signs the public key with Ed25519,
 * and provides vault key wrap/unwrap using the derived shared secret.
 */
export class KeyExchangeSession {
  private readonly x25519Private: KeyObject;
  private readonly x25519PublicRaw: Uint8Array;
  private readonly ed25519PublicRaw: Uint8Array;
  private readonly ed25519Signature: Uint8Array;

  private constructor(
    x25519Private: KeyObject,
    x25519PublicRaw: Uint8Array,
    ed25519PublicRaw: Uint8Array,
    ed25519Signature: Uint8Array,
  ) {
    this.x25519Private = x25519Private;
    this.x25519PublicRaw = x25519PublicRaw;
    this.ed25519PublicRaw = ed25519PublicRaw;
    this.ed25519Signature = ed25519Signature;
  }

  static async generate(): Promise<KeyExchangeSession> {
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    const derBuf = publicKey.export({ type: 'spki', format: 'der' });
    const x25519PubRaw = new Uint8Array(derBuf.subarray(derBuf.length - 32));

    const { ed25519Public, signature } = await signWithEd25519(x25519PubRaw);
    return new KeyExchangeSession(privateKey, x25519PubRaw, ed25519Public, signature);
  }

  getPublicKeys(): PublicKeys {
    return {
      x25519: this.x25519PublicRaw,
      ed25519: this.ed25519PublicRaw,
      signature: this.ed25519Signature,
    };
  }

  /** Compute X25519 shared secret from their raw 32-byte public key. */
  computeSharedSecret(theirX25519Public: Uint8Array): Uint8Array {
    const theirSpki = Buffer.concat([X25519_SPKI_PREFIX, theirX25519Public]);
    const theirKey = createPublicKey({ key: theirSpki, format: 'der', type: 'spki' });
    return new Uint8Array(
      diffieHellman({ privateKey: this.x25519Private, publicKey: theirKey })
    );
  }

  /** Wrap vault key with AES-256-GCM using shared secret. */
  wrapVaultKey(vaultKey: Uint8Array, sharedSecret: Uint8Array): WrappedKey {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', sharedSecret, iv);
    const encrypted = Buffer.concat([cipher.update(vaultKey), cipher.final()]);
    return {
      ciphertext: encrypted.toString('base64'),
      iv: iv.toString('hex'),
      authTag: cipher.getAuthTag().toString('hex'),
    };
  }

  /** Unwrap vault key from AES-256-GCM encrypted payload. */
  unwrapVaultKey(wrapped: WrappedKey, sharedSecret: Uint8Array): Uint8Array {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      sharedSecret,
      Buffer.from(wrapped.iv, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(wrapped.authTag, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(wrapped.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return new Uint8Array(decrypted);
  }
}

/**
 * Sign X25519 public key with Ed25519.
 * Production: POST to signing service at 172.17.0.1:49153.
 * Dev fallback: ephemeral Ed25519 keypair (logged as warning).
 */
async function signWithEd25519(
  data: Uint8Array,
): Promise<{ ed25519Public: Uint8Array; signature: Uint8Array }> {
  if (process.env.DEV_MODE !== 'true') {
    try {
      return await productionSign(data);
    } catch (err) {
      console.warn('[key-exchange] production signing service unreachable, using dev fallback:', err);
    }
  }
  return devSign(data);
}

async function productionSign(
  data: Uint8Array,
): Promise<{ ed25519Public: Uint8Array; signature: Uint8Array }> {
  const res = await fetch('http://172.17.0.1:49153/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key_type: 'ed25519',
      payload: Buffer.from(data).toString('base64'),
    }),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) throw new Error(`signing service returned ${res.status}`);
  const json = await res.json() as { signature: string };
  const signatureBytes = new Uint8Array(Buffer.from(json.signature, 'base64'));

  // Read Ed25519 public key — last 32 bytes of DER-encoded SPKI
  const pemContent = await readFile('/mnt/secure/docker_public_key_ed25519.pem', 'utf-8');
  const key = createPublicKey(pemContent);
  const derBuf = key.export({ type: 'spki', format: 'der' });
  const ed25519Public = new Uint8Array(derBuf.subarray(derBuf.length - 32));

  return { ed25519Public, signature: signatureBytes };
}

function devSign(
  data: Uint8Array,
): { ed25519Public: Uint8Array; signature: Uint8Array } {
  console.warn('[key-exchange] using ephemeral ed25519 keypair — DEV MODE ONLY');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const signature = sign(null, data, privateKey);
  const derBuf = publicKey.export({ type: 'spki', format: 'der' });
  const ed25519Public = new Uint8Array(derBuf.subarray(derBuf.length - 32));
  return { ed25519Public, signature: new Uint8Array(signature) };
}
