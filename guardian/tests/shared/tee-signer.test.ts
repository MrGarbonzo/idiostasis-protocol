import { describe, it, expect } from 'vitest';
import { createDevSigner } from '../../src/shared/tee-signer.js';

describe('TEESigner (dev mode)', () => {
  it('creates a signer with ed25519 and X25519 keys', () => {
    const signer = createDevSigner();
    expect(signer.ed25519PubkeyBase64).toBeTruthy();
    expect(signer.x25519PubkeyBase64).toBeTruthy();
    expect(signer.x25519Signature).toBeTruthy();
    expect(signer.isProduction).toBe(false);

    // ed25519 pubkey should be 32 bytes raw
    const ed25519Raw = Buffer.from(signer.ed25519PubkeyBase64, 'base64');
    expect(ed25519Raw.length).toBe(32);

    // X25519 pubkey should be 32 bytes raw
    const x25519Raw = Buffer.from(signer.x25519PubkeyBase64, 'base64');
    expect(x25519Raw.length).toBe(32);
  });

  it('signs and verifies data', async () => {
    const signer = createDevSigner();
    const data = 'hello world';
    const signature = await signer.sign(data);

    expect(typeof signature).toBe('string');
    expect(signature.length).toBeGreaterThan(0);

    // Verify with correct pubkey
    const valid = signer.verify(data, signature, signer.ed25519PubkeyBase64);
    expect(valid).toBe(true);
  });

  it('rejects tampered data', async () => {
    const signer = createDevSigner();
    const signature = await signer.sign('original data');

    const valid = signer.verify('tampered data', signature, signer.ed25519PubkeyBase64);
    expect(valid).toBe(false);
  });

  it('rejects wrong public key', async () => {
    const signer1 = createDevSigner();
    const signer2 = createDevSigner();

    const signature = await signer1.sign('test data');

    // Verify against wrong pubkey
    const valid = signer1.verify('test data', signature, signer2.ed25519PubkeyBase64);
    expect(valid).toBe(false);
  });

  it('rejects invalid signature format', () => {
    const signer = createDevSigner();
    const valid = signer.verify('test', 'not-valid-base64!!!', signer.ed25519PubkeyBase64);
    expect(valid).toBe(false);
  });

  it('signs buffer data', async () => {
    const signer = createDevSigner();
    const buf = Buffer.from([1, 2, 3, 4, 5]);
    const signature = await signer.sign(buf);

    const valid = signer.verify(buf, signature, signer.ed25519PubkeyBase64);
    expect(valid).toBe(true);
  });

  it('verifies X25519 pubkey is signed by ed25519', () => {
    const signer = createDevSigner();

    // Verify using base64 string (matches how attestation-verifier calls it:
    // signer.verify(request.x25519Pubkey, ...) where x25519Pubkey is base64).
    // SecretVM signs the base64 payload string, not decoded bytes.
    const valid = signer.verify(signer.x25519PubkeyBase64, signer.x25519Signature, signer.ed25519PubkeyBase64);
    expect(valid).toBe(true);
  });

  it('ECDH produces the same shared secret on both sides', () => {
    const signerA = createDevSigner();
    const signerB = createDevSigner();

    const sharedA = signerA.ecdh(signerB.x25519PubkeyBase64);
    const sharedB = signerB.ecdh(signerA.x25519PubkeyBase64);

    expect(sharedA.equals(sharedB)).toBe(true);
    expect(sharedA.length).toBe(32); // X25519 shared secret is 32 bytes
  });

  it('ECDH produces different secrets for different peers', () => {
    const signerA = createDevSigner();
    const signerB = createDevSigner();
    const signerC = createDevSigner();

    const sharedAB = signerA.ecdh(signerB.x25519PubkeyBase64);
    const sharedAC = signerA.ecdh(signerC.x25519PubkeyBase64);

    expect(sharedAB.equals(sharedAC)).toBe(false);
  });

  it('each signer gets unique keys', () => {
    const signer1 = createDevSigner();
    const signer2 = createDevSigner();

    expect(signer1.ed25519PubkeyBase64).not.toBe(signer2.ed25519PubkeyBase64);
    expect(signer1.x25519PubkeyBase64).not.toBe(signer2.x25519PubkeyBase64);
  });
});
