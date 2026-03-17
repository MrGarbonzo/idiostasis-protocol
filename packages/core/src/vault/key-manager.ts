import { randomBytes } from 'node:crypto';
import { generateMnemonic, english } from 'viem/accounts';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { deriveSealingKey, sealData, unsealData } from './sealing.js';
import type { SealedData } from './sealing.js';

const TEE_SEALED_PATH = '/dev/attestation/keys/vault-key';
const FILE_SEALED_PATH = '/data/vault-key.sealed';

export class VaultKeyManager {
  private key: Uint8Array;
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

  /**
   * Replace the in-memory vault key.
   * Caller must call seal() explicitly after replacement.
   * Used during vault key rotation on succession (Decision 6).
   */
  replaceKey(newKey: Uint8Array): void {
    this.key = newKey;
  }

  /** Seal vault key to all available paths (not just first). */
  async seal(): Promise<void> {
    const sealingKey = await deriveSealingKey();
    const sealed = sealData(this.key, sealingKey);
    const json = JSON.stringify(sealed);

    let sealedCount = 0;
    for (const path of [TEE_SEALED_PATH, FILE_SEALED_PATH]) {
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, json, 'utf-8');
        console.log(`[vault] sealed vault key to ${path}`);
        sealedCount++;
      } catch {
        // Path not writable — try next
      }
    }

    if (sealedCount === 0) {
      throw new Error('vault: failed to seal key — no writable path available');
    }
  }
}

/**
 * Generate a new BIP39 mnemonic for the agent's EVM wallet.
 * Called once on first boot inside the TEE.
 * Stored encrypted in the protocol DB under CONFIG_KEYS.EVM_MNEMONIC.
 * Survives succession via DB recovery — the new primary uses
 * the same mnemonic and therefore the same EVM address.
 * Never logged. Never in plaintext outside the encrypted DB.
 */
export function generateAgentMnemonic(): string {
  return generateMnemonic(english);
}
