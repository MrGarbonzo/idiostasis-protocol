import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VaultKeyManager } from './key-manager.js';
import { deriveSealingKey, sealData, unsealData } from './sealing.js';
import { randomBytes } from 'node:crypto';

describe('VaultKeyManager', () => {
  it('generates a 32-byte key on first boot', async () => {
    // In test env, TEE/file paths don't exist → generates new key
    const manager = await VaultKeyManager.load();
    const key = manager.getKey();
    assert.equal(key.length, 32);
    assert.ok(key instanceof Uint8Array);
  });

  it('isFirstBoot() returns true when key was generated', async () => {
    const manager = await VaultKeyManager.load();
    assert.equal(manager.isFirstBoot(), true);
  });
});

describe('sealing', () => {
  it('sealed format contains ciphertext, iv, authTag, version fields', async () => {
    const sealingKey = await deriveSealingKey('test-instance-1');
    const data = new Uint8Array(randomBytes(32));
    const sealed = sealData(data, sealingKey);

    assert.equal(typeof sealed.ciphertext, 'string');
    assert.equal(typeof sealed.iv, 'string');
    assert.equal(typeof sealed.authTag, 'string');
    assert.equal(sealed.version, 1);

    // IV should be 12 bytes = 24 hex chars
    assert.equal(sealed.iv.length, 24);
    // AuthTag should be 16 bytes = 32 hex chars
    assert.equal(sealed.authTag.length, 32);
  });

  it('unseal(seal(data)) === data (round-trip)', async () => {
    const sealingKey = await deriveSealingKey('test-instance-roundtrip');
    const original = new Uint8Array(randomBytes(64));
    const sealed = sealData(original, sealingKey);
    const unsealed = unsealData(sealed, sealingKey);

    assert.deepStrictEqual(unsealed, original);
  });

  it('different teeInstanceIds produce different sealing keys', async () => {
    const key1 = await deriveSealingKey('instance-alpha');
    const key2 = await deriveSealingKey('instance-beta');

    assert.notDeepStrictEqual(key1, key2);
  });

  it('unseal fails with wrong sealing key', async () => {
    const key1 = await deriveSealingKey('correct-instance');
    const key2 = await deriveSealingKey('wrong-instance');
    const data = new Uint8Array(randomBytes(32));
    const sealed = sealData(data, key1);

    assert.throws(() => unsealData(sealed, key2));
  });
});
