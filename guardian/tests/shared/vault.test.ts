import { describe, it, expect } from 'vitest';
import { createDevSigner } from '../../src/shared/tee-signer.js';
import {
  generateVaultKey,
  encrypt,
  decrypt,
  wrapVaultKey,
  unwrapVaultKey,
  encryptDB,
  decryptDB,
} from '../../src/shared/vault.js';

describe('Vault', () => {
  describe('generateVaultKey', () => {
    it('generates a 32-byte key', () => {
      const key = generateVaultKey();
      expect(key.length).toBe(32);
    });

    it('generates unique keys', () => {
      const key1 = generateVaultKey();
      const key2 = generateVaultKey();
      expect(key1.equals(key2)).toBe(false);
    });
  });

  describe('encrypt / decrypt', () => {
    it('round-trips plaintext data', () => {
      const key = generateVaultKey();
      const plaintext = Buffer.from('hello world, this is secret data');

      const encrypted = encrypt(key, plaintext);
      const decrypted = decrypt(key, encrypted);

      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it('round-trips empty data', () => {
      const key = generateVaultKey();
      const plaintext = Buffer.alloc(0);

      const encrypted = encrypt(key, plaintext);
      const decrypted = decrypt(key, encrypted);

      expect(decrypted.length).toBe(0);
    });

    it('round-trips large data', () => {
      const key = generateVaultKey();
      const plaintext = Buffer.alloc(1024 * 1024, 0xAB); // 1 MB

      const encrypted = encrypt(key, plaintext);
      const decrypted = decrypt(key, encrypted);

      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it('produces different ciphertext for same plaintext (random IV)', () => {
      const key = generateVaultKey();
      const plaintext = Buffer.from('same data');

      const enc1 = encrypt(key, plaintext);
      const enc2 = encrypt(key, plaintext);

      // IVs should be different
      expect(enc1.iv).not.toBe(enc2.iv);
      // Ciphertext should be different
      expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
    });

    it('rejects wrong key', () => {
      const key1 = generateVaultKey();
      const key2 = generateVaultKey();
      const plaintext = Buffer.from('secret');

      const encrypted = encrypt(key1, plaintext);

      expect(() => decrypt(key2, encrypted)).toThrow();
    });

    it('rejects tampered ciphertext', () => {
      const key = generateVaultKey();
      const plaintext = Buffer.from('secret');

      const encrypted = encrypt(key, plaintext);
      // Tamper with ciphertext
      const tampered = Buffer.from(encrypted.ciphertext, 'base64');
      tampered[0] ^= 0xFF;
      encrypted.ciphertext = tampered.toString('base64');

      expect(() => decrypt(key, encrypted)).toThrow();
    });

    it('rejects tampered auth tag', () => {
      const key = generateVaultKey();
      const plaintext = Buffer.from('secret');

      const encrypted = encrypt(key, plaintext);
      // Tamper with auth tag
      encrypted.authTag = 'ff'.repeat(16);

      expect(() => decrypt(key, encrypted)).toThrow();
    });

    it('encrypted data fields have expected formats', () => {
      const key = generateVaultKey();
      const encrypted = encrypt(key, Buffer.from('test'));

      // Ciphertext is base64
      expect(() => Buffer.from(encrypted.ciphertext, 'base64')).not.toThrow();
      // IV is 12 bytes hex (24 hex chars)
      expect(encrypted.iv).toHaveLength(24);
      // Auth tag is 16 bytes hex (32 hex chars)
      expect(encrypted.authTag).toHaveLength(32);
    });
  });

  describe('wrapVaultKey / unwrapVaultKey', () => {
    it('round-trips vault key between two signers', async () => {
      const signerA = createDevSigner();
      const signerB = createDevSigner();
      const vaultKey = generateVaultKey();

      // A wraps vault key for B
      const wrapped = await wrapVaultKey(vaultKey, signerA, signerB.x25519PubkeyBase64);

      // B unwraps vault key from A
      const unwrapped = unwrapVaultKey(wrapped, signerB, signerA.ed25519PubkeyBase64);

      expect(unwrapped.equals(vaultKey)).toBe(true);
    });

    it('wrong receiver cannot unwrap', async () => {
      const signerA = createDevSigner();
      const signerB = createDevSigner();
      const signerC = createDevSigner();
      const vaultKey = generateVaultKey();

      // A wraps for B
      const wrapped = await wrapVaultKey(vaultKey, signerA, signerB.x25519PubkeyBase64);

      // C tries to unwrap (wrong ECDH key → wrong shared secret → decryption fails)
      expect(() => unwrapVaultKey(wrapped, signerC, signerA.ed25519PubkeyBase64)).toThrow();
    });

    it('rejects forged signature', async () => {
      const signerA = createDevSigner();
      const signerB = createDevSigner();
      const vaultKey = generateVaultKey();

      const wrapped = await wrapVaultKey(vaultKey, signerA, signerB.x25519PubkeyBase64);

      // Tamper with signature
      wrapped.signature = 'AAAA' + wrapped.signature.substring(4);

      expect(() => unwrapVaultKey(wrapped, signerB, signerA.ed25519PubkeyBase64)).toThrow(
        /invalid signature/i,
      );
    });

    it('wrapped data includes sender X25519 pubkey', async () => {
      const signerA = createDevSigner();
      const signerB = createDevSigner();
      const vaultKey = generateVaultKey();

      const wrapped = await wrapVaultKey(vaultKey, signerA, signerB.x25519PubkeyBase64);

      expect(wrapped.senderX25519Pubkey).toBe(signerA.x25519PubkeyBase64);
    });
  });

  describe('encryptDB / decryptDB', () => {
    it('round-trips a simulated database', () => {
      const vaultKey = generateVaultKey();
      const dbData = Buffer.from(JSON.stringify({
        mnemonics: ['abandon abandon abandon...'],
        balances: { SOL: 100, USDC: 5000 },
      }));

      const encrypted = encryptDB(vaultKey, dbData);
      const decrypted = decryptDB(vaultKey, encrypted);

      expect(decrypted.equals(dbData)).toBe(true);
      expect(JSON.parse(decrypted.toString()).mnemonics[0]).toContain('abandon');
    });
  });
});
