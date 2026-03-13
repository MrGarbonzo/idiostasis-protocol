/**
 * Vault Key Manager — persists the vault key across container restarts.
 *
 * Key storage priority:
 *   1. VAULT_KEY env var (explicit override)
 *   2. TEE-sealed key at /dev/attestation/keys/vault-key (hardware-bound)
 *   3. File-sealed key at /data/vault-key.sealed (encrypted with TEE measurement)
 *   4. Generate new key (first boot only)
 *
 * The key is sealed using AES-256-GCM with a derivation of the TEE instance ID
 * and code hash, ensuring it can only be unsealed by the same TEE environment.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';

const TEE_SEALED_PATH = '/dev/attestation/keys/vault-key';
const FILE_SEALED_PATH = '/data/vault-key.sealed';

interface SealedKeyFile {
  ciphertext: string;
  iv: string;
  authTag: string;
  version: 1;
}

export class VaultKeyManager {
  private vaultKey: Buffer | null = null;
  private sealingKey: Buffer;

  /**
   * @param teeInstanceId - TEE instance ID (used for key derivation)
   * @param codeHash - Code measurement hash (used for key derivation)
   */
  constructor(teeInstanceId: string, codeHash: string) {
    // Derive a sealing key from TEE identity — only the same TEE can unseal
    this.sealingKey = createHash('sha256')
      .update(`vault-seal|${teeInstanceId}|${codeHash}`)
      .digest();
  }

  /** Whether a vault key is loaded. */
  get hasKey(): boolean {
    return this.vaultKey !== null;
  }

  /** Get the vault key. Throws if not initialized. */
  getKey(): Buffer {
    if (!this.vaultKey) throw new Error('Vault key not initialized — call initialize() first');
    return this.vaultKey;
  }

  /**
   * Initialize the vault key manager.
   * Tries to load from sealed storage, falls back to generating a new key.
   * Returns the vault key buffer.
   */
  initialize(envVaultKey?: string): Buffer {
    // Priority 1: Explicit env var
    if (envVaultKey) {
      this.vaultKey = Buffer.from(envVaultKey, 'hex');
      console.log('[VaultKeyManager] Key loaded from VAULT_KEY env var');
      return this.vaultKey;
    }

    // Priority 2: TEE-sealed key
    if (existsSync(TEE_SEALED_PATH)) {
      try {
        this.vaultKey = this.unsealFromFile(TEE_SEALED_PATH);
        console.log('[VaultKeyManager] Key loaded from TEE-sealed storage');
        return this.vaultKey;
      } catch (err) {
        console.warn(`[VaultKeyManager] Failed to unseal TEE key: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Priority 3: File-sealed key
    if (existsSync(FILE_SEALED_PATH)) {
      try {
        this.vaultKey = this.unsealFromFile(FILE_SEALED_PATH);
        console.log('[VaultKeyManager] Key loaded from file-sealed storage');
        return this.vaultKey;
      } catch (err) {
        console.warn(`[VaultKeyManager] Failed to unseal file key: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Priority 4: Generate new key (first boot)
    this.vaultKey = randomBytes(32);
    console.log('[VaultKeyManager] Generated new vault key (first boot)');

    // Persist the new key
    this.persist();

    return this.vaultKey;
  }

  /** Persist the current key to sealed storage. */
  private persist(): void {
    if (!this.vaultKey) return;

    // Try TEE-sealed path first
    try {
      this.sealToFile(this.vaultKey, TEE_SEALED_PATH);
      console.log('[VaultKeyManager] Key sealed to TEE storage');
    } catch {
      // TEE path may not be available (no volume mount)
    }

    // Always try file-sealed path as fallback
    try {
      this.sealToFile(this.vaultKey, FILE_SEALED_PATH);
      console.log('[VaultKeyManager] Key sealed to file storage');
    } catch (err) {
      console.warn(`[VaultKeyManager] Failed to seal to file: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Encrypt and write a key to a file. */
  private sealToFile(key: Buffer, path: string): void {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.sealingKey, iv);
    const encrypted = Buffer.concat([cipher.update(key), cipher.final()]);

    const sealed: SealedKeyFile = {
      ciphertext: encrypted.toString('base64'),
      iv: iv.toString('hex'),
      authTag: cipher.getAuthTag().toString('hex'),
      version: 1,
    };

    writeFileSync(path, JSON.stringify(sealed), 'utf-8');
  }

  /** Read and decrypt a key from a sealed file. */
  private unsealFromFile(path: string): Buffer {
    const raw = readFileSync(path, 'utf-8');
    const sealed = JSON.parse(raw) as SealedKeyFile;

    const iv = Buffer.from(sealed.iv, 'hex');
    const authTag = Buffer.from(sealed.authTag, 'hex');
    const ciphertext = Buffer.from(sealed.ciphertext, 'base64');

    const decipher = createDecipheriv('aes-256-gcm', this.sealingKey, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
