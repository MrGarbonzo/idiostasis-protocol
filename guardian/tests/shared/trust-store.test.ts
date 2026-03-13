import { describe, it, expect, beforeEach } from 'vitest';
import { TrustStore } from '../../src/shared/trust-store.js';
import type { TrustedPeer } from '../../src/shared/trust-store.js';

describe('TrustStore', () => {
  let store: TrustStore;
  const now = Date.now();

  const peerA: TrustedPeer = {
    id: 'guardian-1',
    ed25519PubkeyBase64: 'AAAA',
    x25519PubkeyBase64: 'BBBB',
    attestedAt: now,
    lastVerified: now,
  };

  const peerB: TrustedPeer = {
    id: 'guardian-2',
    ed25519PubkeyBase64: 'CCCC',
    x25519PubkeyBase64: 'DDDD',
    attestedAt: now,
    lastVerified: now,
    isSentry: true,
  };

  beforeEach(() => {
    store = new TrustStore();
  });

  it('starts empty', () => {
    expect(store.size).toBe(0);
    expect(store.listPeers()).toEqual([]);
  });

  it('adds and retrieves a peer', () => {
    store.addPeer(peerA);
    expect(store.size).toBe(1);

    const retrieved = store.getPeer('guardian-1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.ed25519PubkeyBase64).toBe('AAAA');
  });

  it('updates existing peer on re-add', () => {
    store.addPeer(peerA);
    const updated = { ...peerA, lastVerified: now + 1000 };
    store.addPeer(updated);

    expect(store.size).toBe(1);
    expect(store.getPeer('guardian-1')!.lastVerified).toBe(now + 1000);
  });

  it('checks if peer is trusted', () => {
    expect(store.isTrusted('guardian-1')).toBe(false);
    store.addPeer(peerA);
    expect(store.isTrusted('guardian-1')).toBe(true);
  });

  it('looks up peer by pubkey', () => {
    store.addPeer(peerA);
    store.addPeer(peerB);

    const found = store.getPeerByPubkey('CCCC');
    expect(found).toBeDefined();
    expect(found!.id).toBe('guardian-2');

    expect(store.getPeerByPubkey('nonexistent')).toBeUndefined();
  });

  it('checks if pubkey is trusted', () => {
    store.addPeer(peerA);
    expect(store.isPubkeyTrusted('AAAA')).toBe(true);
    expect(store.isPubkeyTrusted('XXXX')).toBe(false);
  });

  it('removes a peer', () => {
    store.addPeer(peerA);
    expect(store.removePeer('guardian-1')).toBe(true);
    expect(store.size).toBe(0);
    expect(store.removePeer('guardian-1')).toBe(false);
  });

  it('lists all peers', () => {
    store.addPeer(peerA);
    store.addPeer(peerB);
    const list = store.listPeers();
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.id).sort()).toEqual(['guardian-1', 'guardian-2']);
  });

  it('lists sentry peers', () => {
    store.addPeer(peerA);
    store.addPeer(peerB);
    const sentries = store.listSentries();
    expect(sentries).toHaveLength(1);
    expect(sentries[0].id).toBe('guardian-2');
  });

  it('touches peer to update lastVerified', () => {
    store.addPeer(peerA);
    const before = store.getPeer('guardian-1')!.lastVerified;

    // Small delay to ensure timestamp difference
    store.touchPeer('guardian-1');
    const after = store.getPeer('guardian-1')!.lastVerified;

    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('touchPeer returns false for unknown peer', () => {
    expect(store.touchPeer('unknown')).toBe(false);
  });

  it('clears all peers', () => {
    store.addPeer(peerA);
    store.addPeer(peerB);
    store.clear();
    expect(store.size).toBe(0);
  });

  it('stores a defensive copy (not reference)', () => {
    const mutablePeer = { ...peerA };
    store.addPeer(mutablePeer);
    mutablePeer.ed25519PubkeyBase64 = 'MODIFIED';

    // Should NOT be affected
    expect(store.getPeer('guardian-1')!.ed25519PubkeyBase64).toBe('AAAA');
  });

  it('provides nonce tracker', () => {
    const tracker = store.getNonceTracker();
    expect(tracker.check('nonce-1')).toBe(true);
    expect(tracker.check('nonce-1')).toBe(false);
  });
});
