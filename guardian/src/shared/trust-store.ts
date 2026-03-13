/**
 * Trust Store — in-memory registry of attested/trusted peers.
 *
 * Tracks:
 * - Peer ed25519 public keys (verified via attestation)
 * - Peer X25519 public keys (for ECDH vault key exchange)
 * - Attestation status and verification timestamps
 * - Nonce deduplication for replay protection
 */
import { NonceTracker } from './signed-envelope.js';
import { formatTrustPeerAdded, formatTrustPeerRemoved } from './telegram-protocol.js';

// ── Types ────────────────────────────────────────────────────────

export interface TrustedPeer {
  /** Peer identifier (guardian address or TEE instance ID). */
  id: string;
  /** ed25519 public key (base64, raw 32 bytes). */
  ed25519PubkeyBase64: string;
  /** X25519 public key for ECDH (base64, raw 32 bytes). */
  x25519PubkeyBase64: string;
  /** When this peer was first attested (Unix ms). */
  attestedAt: number;
  /** When attestation was last verified (Unix ms). */
  lastVerified: number;
  /** Optional attestation quote (for re-verification). */
  attestationQuote?: string;
  /** Optional endpoint URL for this peer. */
  endpoint?: string;
  /** Whether this peer is a sentry. */
  isSentry?: boolean;
}

// ── Trust Store ──────────────────────────────────────────────────

export class TrustStore {
  private peers: Map<string, TrustedPeer> = new Map();
  private nonceTracker: NonceTracker;
  private onEvent?: (msg: string) => void;

  constructor(nonceCacheSize = 10_000, onEvent?: (msg: string) => void) {
    this.nonceTracker = new NonceTracker(nonceCacheSize);
    this.onEvent = onEvent;
  }

  /**
   * Add or update a trusted peer.
   * Only call this after successful attestation verification.
   */
  addPeer(peer: TrustedPeer): void {
    this.peers.set(peer.id, { ...peer });
    this.onEvent?.(formatTrustPeerAdded({ peerId: peer.id, isSentry: peer.isSentry ?? false }));
  }

  /** Get a trusted peer by ID. */
  getPeer(id: string): TrustedPeer | undefined {
    return this.peers.get(id);
  }

  /** Get a trusted peer by their ed25519 public key. */
  getPeerByPubkey(ed25519PubkeyBase64: string): TrustedPeer | undefined {
    for (const peer of this.peers.values()) {
      if (peer.ed25519PubkeyBase64 === ed25519PubkeyBase64) return peer;
    }
    return undefined;
  }

  /** Check if a peer is trusted. */
  isTrusted(id: string): boolean {
    return this.peers.has(id);
  }

  /** Check if a pubkey belongs to a trusted peer. */
  isPubkeyTrusted(ed25519PubkeyBase64: string): boolean {
    return this.getPeerByPubkey(ed25519PubkeyBase64) !== undefined;
  }

  /** Remove a peer from the trust store. */
  removePeer(id: string): boolean {
    const removed = this.peers.delete(id);
    if (removed) {
      this.onEvent?.(formatTrustPeerRemoved({ peerId: id }));
    }
    return removed;
  }

  /** Get all trusted peers. */
  listPeers(): TrustedPeer[] {
    return Array.from(this.peers.values());
  }

  /** Get all sentry peers. */
  listSentries(): TrustedPeer[] {
    return this.listPeers().filter((p) => p.isSentry);
  }

  /** Number of trusted peers. */
  get size(): number {
    return this.peers.size;
  }

  /** Update the lastVerified timestamp for a peer. */
  touchPeer(id: string): boolean {
    const peer = this.peers.get(id);
    if (!peer) return false;
    peer.lastVerified = Date.now();
    return true;
  }

  /** Get the nonce tracker (shared across all peers). */
  getNonceTracker(): NonceTracker {
    return this.nonceTracker;
  }

  /** Clear all peers (useful for vault key rotation / testing). */
  clear(): void {
    this.peers.clear();
  }
}
