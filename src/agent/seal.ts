/**
 * AES-256-GCM seal/unseal for boot-agent sealed configs.
 * Copied from boot-agent/src/sealed/seal.ts — must stay in sync.
 */
import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';

/** Format of a sealed JSON file (AES-256-GCM). */
export interface SealedFile {
  ciphertext: string;
  iv: string;
  authTag: string;
  version: 1;
}

/** Derive a sealing key from TEE identity components. */
export function deriveSealingKey(teeInstanceId: string, codeHash: string): Buffer {
  return createHash('sha256')
    .update(`boot-seal|${teeInstanceId}|${codeHash}`)
    .digest();
}

/** Encrypt plaintext bytes with AES-256-GCM. */
export function seal(key: Buffer, plaintext: Buffer): SealedFile {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
    version: 1,
  };
}

/** Decrypt a sealed file with AES-256-GCM. */
export function unseal(key: Buffer, sealed: SealedFile): Buffer {
  const iv = Buffer.from(sealed.iv, 'hex');
  const authTag = Buffer.from(sealed.authTag, 'hex');
  const ciphertext = Buffer.from(sealed.ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
