import { describe, it, expect, beforeEach } from 'vitest';
import { createDevSigner } from '../../src/shared/tee-signer.js';
import { TrustStore } from '../../src/shared/trust-store.js';
import { AttestationVerifier } from '../../src/shared/attestation-verifier.js';
import type { AttestationRequest } from '../../src/shared/attestation-verifier.js';
import type { TEESigner } from '../../src/shared/tee-signer.js';

describe('AttestationVerifier', () => {
  let verifier: AttestationVerifier;
  let trustStore: TrustStore;
  let localSigner: TEESigner;

  beforeEach(() => {
    verifier = new AttestationVerifier({ devMode: true });
    trustStore = new TrustStore();
    localSigner = createDevSigner();
  });

  function makeRequest(signer: TEESigner, overrides?: Partial<AttestationRequest>): AttestationRequest {
    return {
      ed25519Pubkey: signer.ed25519PubkeyBase64,
      attestationQuote: 'dev-quote',
      x25519Pubkey: signer.x25519PubkeyBase64,
      x25519Signature: signer.x25519Signature,
      senderId: 'test-peer-1',
      endpoint: 'http://localhost:3100',
      ...overrides,
    };
  }

  it('accepts valid attestation in dev mode', async () => {
    const peerSigner = createDevSigner();
    const request = makeRequest(peerSigner);

    const result = await verifier.verifyAndTrust(request, localSigner, trustStore);

    expect(result.valid).toBe(true);
    expect(result.peerId).toBe('test-peer-1');
    expect(trustStore.isTrusted('test-peer-1')).toBe(true);
  });

  it('adds peer with correct keys to trust store', async () => {
    const peerSigner = createDevSigner();
    const request = makeRequest(peerSigner, { senderId: 'peer-42' });

    await verifier.verifyAndTrust(request, localSigner, trustStore);

    const peer = trustStore.getPeer('peer-42');
    expect(peer).toBeDefined();
    expect(peer!.ed25519PubkeyBase64).toBe(peerSigner.ed25519PubkeyBase64);
    expect(peer!.x25519PubkeyBase64).toBe(peerSigner.x25519PubkeyBase64);
    expect(peer!.endpoint).toBe('http://localhost:3100');
  });

  it('rejects invalid X25519 signature', async () => {
    const peerSigner = createDevSigner();
    const request = makeRequest(peerSigner, {
      x25519Signature: 'invalid-signature-base64',
    });

    const result = await verifier.verifyAndTrust(request, localSigner, trustStore);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('X25519 pubkey signature invalid');
    expect(trustStore.size).toBe(0);
  });

  it('rejects mismatched X25519 pubkey and signature', async () => {
    const peerSigner = createDevSigner();
    const otherSigner = createDevSigner();

    // X25519 pubkey from peerSigner but signature from otherSigner
    const request = makeRequest(peerSigner, {
      x25519Pubkey: otherSigner.x25519PubkeyBase64,
      // signature was over peerSigner's x25519 key, not otherSigner's
    });

    const result = await verifier.verifyAndTrust(request, localSigner, trustStore);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('X25519 pubkey signature invalid');
  });

  it('stores attestation quote in trust store', async () => {
    const peerSigner = createDevSigner();
    const request = makeRequest(peerSigner, {
      attestationQuote: 'real-attestation-quote-data',
    });

    await verifier.verifyAndTrust(request, localSigner, trustStore);

    const peer = trustStore.getPeer('test-peer-1');
    expect(peer!.attestationQuote).toBe('real-attestation-quote-data');
  });

  it('records sentry status', async () => {
    const peerSigner = createDevSigner();
    const request = makeRequest(peerSigner, { isSentry: true });

    await verifier.verifyAndTrust(request, localSigner, trustStore);

    const peer = trustStore.getPeer('test-peer-1');
    expect(peer!.isSentry).toBe(true);
  });

  it('can verify multiple peers', async () => {
    const peer1 = createDevSigner();
    const peer2 = createDevSigner();

    await verifier.verifyAndTrust(
      makeRequest(peer1, { senderId: 'peer-1' }),
      localSigner,
      trustStore,
    );
    await verifier.verifyAndTrust(
      makeRequest(peer2, { senderId: 'peer-2' }),
      localSigner,
      trustStore,
    );

    expect(trustStore.size).toBe(2);
    expect(trustStore.isTrusted('peer-1')).toBe(true);
    expect(trustStore.isTrusted('peer-2')).toBe(true);
  });

  describe('measurement approval', () => {
    it('can add and revoke approved measurements', () => {
      verifier.approveMeasurement('abc123');
      verifier.revokeMeasurement('abc123');
      // No assertion needed — just verifying no errors
    });
  });
});
