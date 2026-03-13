/**
 * Vault — AES-256-GCM encryption for the fund manager database.
 *
 * Handles:
 * - Vault key generation and management
 * - AES-256-GCM encrypt/decrypt of arbitrary data
 * - X25519 ECDH key wrapping for vault key distribution between TEEs
 */
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import type { TEESigner } from './tee-signer.js';

// ── Constants ────────────────────────────────────────────────────

const AES_KEY_BYTES = 32;   // 256 bits
const IV_BYTES = 12;        // 96 bits for GCM
const AUTH_TAG_BYTES = 16;  // 128 bits

// ── Types ────────────────────────────────────────────────────────

export interface EncryptedData {
  /** AES-256-GCM ciphertext (base64). */
  ciphertext: string;
  /** Initialization vector (hex). */
  iv: string;
  /** GCM authentication tag (hex). */
  authTag: string;
}

export interface WrappedVaultKey {
  /** Vault key encrypted with ECDH-derived shared secret (base64). */
  encryptedVaultKey: string;
  /** IV for the vault key encryption (hex). */
  iv: string;
  /** Auth tag for the vault key encryption (hex). */
  authTag: string;
  /** Sender's X25519 public key for ECDH on the receiver side (base64). */
  senderX25519Pubkey: string;
  /** ed25519 signature over the wrapped data (base64). */
  signature: string;
}

// ── Vault Key Generation ─────────────────────────────────────────

/**
 * Generate a new random vault key (32 bytes / 256 bits).
 */
export function generateVaultKey(): Buffer {
  return randomBytes(AES_KEY_BYTES);
}

// ── AES-256-GCM Encryption ──────────────────────────────────────

/**
 * Encrypt data with AES-256-GCM.
 */
export function encrypt(key: Buffer, plaintext: Buffer): EncryptedData {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

/**
 * Decrypt data with AES-256-GCM.
 * Throws on authentication failure (tampered data or wrong key).
 */
export function decrypt(key: Buffer, data: EncryptedData): Buffer {
  const iv = Buffer.from(data.iv, 'hex');
  const authTag = Buffer.from(data.authTag, 'hex');
  const ciphertext = Buffer.from(data.ciphertext, 'base64');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ── Vault Key Wrapping (ECDH + AES-GCM) ─────────────────────────

/**
 * Wrap (encrypt) a vault key for secure transfer to a peer.
 * Uses X25519 ECDH to derive a shared secret, then encrypts the vault key.
 */
export async function wrapVaultKey(
  vaultKey: Buffer,
  signer: TEESigner,
  peerX25519PubkeyBase64: string,
): Promise<WrappedVaultKey> {
  // Derive shared secret via ECDH
  const sharedSecret = signer.ecdh(peerX25519PubkeyBase64);

  // Encrypt vault key with shared secret
  const encrypted = encrypt(sharedSecret, vaultKey);

  // Sign the wrapped data for authenticity
  const signPayload = `${encrypted.ciphertext}|${encrypted.iv}|${encrypted.authTag}`;
  const signature = await signer.sign(signPayload);

  return {
    encryptedVaultKey: encrypted.ciphertext,
    iv: encrypted.iv,
    authTag: encrypted.authTag,
    senderX25519Pubkey: signer.x25519PubkeyBase64,
    signature,
  };
}

/**
 * Unwrap (decrypt) a vault key received from a peer.
 * Uses X25519 ECDH to derive the shared secret, then decrypts the vault key.
 */
export function unwrapVaultKey(
  wrapped: WrappedVaultKey,
  signer: TEESigner,
  senderEd25519PubkeyBase64: string,
): Buffer {
  // Verify signature
  const signPayload = `${wrapped.encryptedVaultKey}|${wrapped.iv}|${wrapped.authTag}`;
  const sigValid = signer.verify(signPayload, wrapped.signature, senderEd25519PubkeyBase64);
  if (!sigValid) {
    throw new Error('Vault key unwrap failed: invalid signature');
  }

  // Derive shared secret via ECDH
  const sharedSecret = signer.ecdh(wrapped.senderX25519Pubkey);

  // Decrypt vault key
  return decrypt(sharedSecret, {
    ciphertext: wrapped.encryptedVaultKey,
    iv: wrapped.iv,
    authTag: wrapped.authTag,
  });
}

// ── DB Encryption Helpers ────────────────────────────────────────

/**
 * Encrypt a database buffer for transit/storage.
 */
export function encryptDB(vaultKey: Buffer, dbBuffer: Buffer): EncryptedData {
  return encrypt(vaultKey, dbBuffer);
}

/**
 * Decrypt a database buffer.
 */
export function decryptDB(vaultKey: Buffer, data: EncryptedData): Buffer {
  return decrypt(vaultKey, data);
}
