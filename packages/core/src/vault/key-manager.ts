import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { deriveSealingKey, sealData, unsealData } from './sealing.js';
import type { SealedData } from './sealing.js';

const TEE_SEALED_PATH = '/dev/attestation/keys/vault-key';
const FILE_SEALED_PATH = '/data/vault-key.sealed';

export class VaultKeyManager {
  private readonly key: Uint8Array;
  private readonly firstBoot: boolean;

  private constructor(key: Uint8Array, firstBoot: boolean) {
    this.key = key;
    this.firstBoot = firstBoot;
  }

  /**
   * Load vault key using 3-tier priority (spec Section 6):
   *   1. TEE-sealed path: /dev/attestation/keys/vault-key
   *   2. File-sealed path: /data/vault-key.sealed
   *   3. Generate new (crypto.randomBytes(32)) — first boot only
   */
  static async load(): Promise<VaultKeyManager> {
    // Priority 1: TEE-sealed path
    try {
      const raw = await readFile(TEE_SEALED_PATH, 'utf-8');
      const sealed: SealedData = JSON.parse(raw);
      const sealingKey = await deriveSealingKey();
      const key = unsealData(sealed, sealingKey);
      console.log('[vault] loaded vault key from TEE-sealed path');
      return new VaultKeyManager(key, false);
    } catch {
      // TEE path not available
    }

    // Priority 2: File-sealed path
    try {
      const raw = await readFile(FILE_SEALED_PATH, 'utf-8');
      const sealed: SealedData = JSON.parse(raw);
      const sealingKey = await deriveSealingKey();
      const key = unsealData(sealed, sealingKey);
      console.log('[vault] loaded vault key from file-sealed path');
      return new VaultKeyManager(key, false);
    } catch {
      // File path not available
    }

    // Priority 3: Generate new vault key
    const key = new Uint8Array(randomBytes(32));
    console.log('[vault] generated new vault key — first boot');
    return new VaultKeyManager(key, true);
  }

  getKey(): Uint8Array {
    return this.key;
  }

  isFirstBoot(): boolean {
    return this.firstBoot;
  }

  /** Seal vault key to the first writable path. */
  async seal(): Promise<void> {
    const sealingKey = await deriveSealingKey();
    const sealed = sealData(this.key, sealingKey);
    const json = JSON.stringify(sealed);

    for (const path of [TEE_SEALED_PATH, FILE_SEALED_PATH]) {
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, json, 'utf-8');
        console.log(`[vault] sealed vault key to ${path}`);
        return;
      } catch {
        continue;
      }
    }

    throw new Error('vault: failed to seal key — no writable path available');
  }
}
