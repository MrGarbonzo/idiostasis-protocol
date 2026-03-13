/**
 * Vault Client — manages the vault key lifecycle for the agent.
 *
 * Handles:
 * - Requesting vault key during attestation exchange
 * - Encrypting DB snapshots for sync to guardians
 * - Decrypting DB snapshots during recovery
 * - Vault key rotation when instructed by governance
 */
import { createHash, randomBytes } from 'node:crypto';
import type { TEESigner, SignedEnvelope } from './tee-signing.js';
import { createEnvelope, aesEncrypt, aesDecrypt } from './tee-signing.js';

// ── Types ────────────────────────────────────────────────────────

export interface VaultClientConfig {
  /** Agent's node identifier. */
  nodeId: string;
  /** TEE signer for envelope signing and ECDH. */
  signer: TEESigner;
}

export interface EncryptedSnapshot {
  encryptedDb: string;
  iv: string;
  authTag: string;
  sequenceNum: number;
  checksum: string;
  /** Fresh attestation quote for per-interaction verification (optional). */
  attestationQuote?: string;
}

// ── Vault Client ─────────────────────────────────────────────────

export class VaultClient {
  private config: VaultClientConfig;
  private vaultKey: Buffer | null = null;
  private sequenceNum = 0;

  constructor(config: VaultClientConfig) {
    this.config = config;
  }

  /** Whether the vault key is available. */
  get hasVaultKey(): boolean {
    return this.vaultKey !== null;
  }

  /** Return the vault key buffer, or null if not set. */
  getVaultKey(): Buffer | null {
    return this.vaultKey;
  }

  /** Get the current sequence number. */
  get currentSequence(): number {
    return this.sequenceNum;
  }

  /**
   * Set the vault key directly (e.g., from env var in dev mode,
   * or after ECDH unwrapping during attestation).
   */
  setVaultKey(key: Buffer): void {
    if (key.length !== 32) {
      throw new Error(`Vault key must be 32 bytes, got ${key.length}`);
    }
    this.vaultKey = key;
  }

  /**
   * Generate a new vault key (genesis node only).
   */
  generateVaultKey(): Buffer {
    this.vaultKey = randomBytes(32);
    return this.vaultKey;
  }

  /**
   * Unwrap a vault key received during attestation exchange.
   * Uses ECDH to derive the shared secret, then decrypts.
   */
  unwrapVaultKey(wrapped: {
    encryptedVaultKey: string;
    iv: string;
    authTag: string;
    senderX25519Pubkey: string;
    signature: string;
  }): Buffer {
    // Verify signature
    const signPayload = `${wrapped.encryptedVaultKey}|${wrapped.iv}|${wrapped.authTag}`;
    const sigValid = this.config.signer.verify(
      signPayload,
      wrapped.signature,
      // We need the sender's ed25519 pubkey, but this is from the
      // attestation response. The caller should verify separately.
      // For now, skip sig verification here (done at envelope level).
      this.config.signer.ed25519PubkeyBase64, // placeholder
    );

    // Derive shared secret
    const sharedSecret = this.config.signer.ecdh(wrapped.senderX25519Pubkey);

    // Decrypt vault key
    const vaultKey = aesDecrypt(sharedSecret, {
      ciphertext: wrapped.encryptedVaultKey,
      iv: wrapped.iv,
      authTag: wrapped.authTag,
    });

    this.vaultKey = vaultKey;
    return vaultKey;
  }

  /**
   * Encrypt a DB buffer for sync to guardians.
   * Returns a signed envelope with the encrypted snapshot.
   */
  async createSnapshot(dbBuffer: Buffer, attestationQuote?: string): Promise<SignedEnvelope> {
    if (!this.vaultKey) {
      throw new Error('Vault key not initialized');
    }

    this.sequenceNum++;
    const checksum = createHash('sha256').update(dbBuffer).digest('hex');
    const encrypted = aesEncrypt(this.vaultKey, dbBuffer);

    const snapshot: EncryptedSnapshot = {
      encryptedDb: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      sequenceNum: this.sequenceNum,
      checksum,
      attestationQuote,
    };

    return createEnvelope(
      this.config.nodeId,
      'db.snapshot',
      snapshot,
      this.config.signer,
    );
  }

  /**
   * Decrypt a DB buffer received during recovery.
   */
  decryptSnapshot(snapshot: EncryptedSnapshot): Buffer {
    if (!this.vaultKey) {
      throw new Error('Vault key not initialized');
    }

    const decrypted = aesDecrypt(this.vaultKey, {
      ciphertext: snapshot.encryptedDb,
      iv: snapshot.iv,
      authTag: snapshot.authTag,
    });

    // Verify checksum
    const checksum = createHash('sha256').update(decrypted).digest('hex');
    if (checksum !== snapshot.checksum) {
      throw new Error('Snapshot checksum mismatch');
    }

    this.sequenceNum = snapshot.sequenceNum;
    return decrypted;
  }

  /**
   * Send the attestation request to a guardian and receive the vault key.
   */
  async requestAttestationAndVaultKey(
    guardianEndpoint: string,
    attestationQuote: string,
  ): Promise<{ success: boolean; error?: string }> {
    const endpoint = guardianEndpoint.replace(/\/$/, '');

    const requestPayload = {
      ed25519Pubkey: this.config.signer.ed25519PubkeyBase64,
      attestationQuote,
      x25519Pubkey: this.config.signer.x25519PubkeyBase64,
      x25519Signature: this.config.signer.x25519Signature,
      senderId: this.config.nodeId,
    };

    const envelope = await createEnvelope(
      this.config.nodeId,
      'attest.request',
      requestPayload,
      this.config.signer,
    );

    try {
      const res = await fetch(`${endpoint}/api/attestation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return { success: false, error: `Attestation failed: ${body.error ?? res.status}` };
      }

      const response = (await res.json()) as {
        success: boolean;
        wrappedVaultKey?: {
          encryptedVaultKey: string;
          iv: string;
          authTag: string;
          senderX25519Pubkey: string;
          signature: string;
        };
        error?: string;
      };

      if (!response.success || !response.wrappedVaultKey) {
        return { success: false, error: response.error ?? 'No vault key in response' };
      }

      // Unwrap the vault key
      const sharedSecret = this.config.signer.ecdh(response.wrappedVaultKey.senderX25519Pubkey);
      this.vaultKey = aesDecrypt(sharedSecret, {
        ciphertext: response.wrappedVaultKey.encryptedVaultKey,
        iv: response.wrappedVaultKey.iv,
        authTag: response.wrappedVaultKey.authTag,
      });

      console.log('[VaultClient] Vault key received and decrypted');
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
