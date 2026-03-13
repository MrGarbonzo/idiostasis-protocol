import { describe, it, expect } from 'vitest';
import {
  parseProtocolMessage,
  formatAgentAnnounce,
  formatGuardianAnnounce,
  formatDiscoverRequest,
  formatDiscoverResponse,
  formatProposalNew,
  formatProposalResult,
  formatHeartbeatStatus,
  formatAttestationRequest,
  formatAttestationVerified,
  formatAttestationRejected,
  formatVaultKeySent,
  formatVaultKeyReceived,
  formatDbSyncSent,
  formatDbSyncReceived,
  formatDbSyncRejected,
  formatRecoveryRequest,
  formatRecoveryServed,
  formatTrustPeerAdded,
  formatTrustPeerRemoved,
} from '../../src/shared/telegram-protocol.js';

describe('telegram-protocol', () => {
  describe('format/parse round-trips', () => {
    it('agent announce', () => {
      const data = { endpoint: 'http://agent:3000', teeId: 'tee-abc123', codeHash: 'sha256:deadbeef' };
      const text = formatAgentAnnounce(data);
      expect(text).toBe('[ANNOUNCE:AGENT] endpoint=http://agent:3000 teeId=tee-abc123 codeHash=sha256:deadbeef');

      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'agent_announce', data });
    });

    it('guardian announce', () => {
      const data = { address: 'guardian-1', endpoint: 'http://g1:3100', isSentry: true };
      const text = formatGuardianAnnounce(data);
      expect(text).toBe('[ANNOUNCE:GUARDIAN] address=guardian-1 endpoint=http://g1:3100 sentry=true');

      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'guardian_announce', data });
    });

    it('guardian announce non-sentry', () => {
      const data = { address: 'guardian-2', endpoint: 'http://g2:3100', isSentry: false };
      const text = formatGuardianAnnounce(data);
      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'guardian_announce', data });
    });

    it('discover request', () => {
      const text = formatDiscoverRequest();
      expect(text).toBe('[DISCOVER:REQUEST]');
      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'discover_request' });
    });

    it('discover response', () => {
      const data = { address: 'guardian-1', endpoint: 'http://g1:3100', isSentry: false };
      const text = formatDiscoverResponse(data);
      expect(text).toBe('[DISCOVER:RESPONSE] address=guardian-1 endpoint=http://g1:3100 sentry=false');

      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'discover_response', data });
    });

    it('proposal new', () => {
      const data = { id: 'prop-abc123', type: 'strategy_change', thresholdPct: 20, deadline: '2026-03-01T00:00:00.000Z' };
      const text = formatProposalNew(data);
      expect(text).toBe('[PROPOSAL:NEW] id=prop-abc123 type=strategy_change threshold=20% deadline=2026-03-01T00:00:00.000Z');

      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'proposal_new', data });
    });

    it('proposal result approved', () => {
      const data = { id: 'prop-abc123', status: 'approved' as const, approvalPct: 85.5 };
      const text = formatProposalResult(data);
      expect(text).toBe('[PROPOSAL:RESULT] id=prop-abc123 status=approved approval=85.5%');

      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'proposal_result', data });
    });

    it('proposal result rejected', () => {
      const data = { id: 'prop-def456', status: 'rejected' as const, approvalPct: 10 };
      const text = formatProposalResult(data);
      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'proposal_result', data });
    });

    it('heartbeat status', () => {
      const data = { active: true, uptime: 3600 };
      const text = formatHeartbeatStatus(data);
      expect(text).toBe('[HEARTBEAT:STATUS] active=true uptime=3600');

      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'heartbeat_status', data });
    });

    it('heartbeat inactive', () => {
      const data = { active: false, uptime: 0 };
      const text = formatHeartbeatStatus(data);
      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'heartbeat_status', data });
    });

    // ── Trust event round-trips ──────────────────────────────

    it('attestation request', () => {
      const data = { peerId: 'guardian-2', pubkey: 'abcd1234' };
      const text = formatAttestationRequest(data);
      expect(text).toBe('[ATTESTATION:REQUEST] peerId=guardian-2 pubkey=abcd1234');
      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'attestation_request', data });
    });

    it('attestation verified', () => {
      const data = { peerId: 'guardian-2', pubkey: 'abcd1234', isSentry: true };
      const text = formatAttestationVerified(data);
      expect(text).toBe('[ATTESTATION:VERIFIED] peerId=guardian-2 pubkey=abcd1234 sentry=true');
      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'attestation_verified', data });
    });

    it('attestation verified non-sentry', () => {
      const data = { peerId: 'guardian-3', pubkey: 'ef567890', isSentry: false };
      const text = formatAttestationVerified(data);
      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'attestation_verified', data });
    });

    it('attestation rejected', () => {
      const data = { peerId: 'guardian-4', reason: 'quote_invalid' };
      const text = formatAttestationRejected(data);
      expect(text).toBe('[ATTESTATION:REJECTED] peerId=guardian-4 reason=quote_invalid');
      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'attestation_rejected', data });
    });

    it('vault key sent', () => {
      const data = { toPeerId: 'guardian-2' };
      const text = formatVaultKeySent(data);
      expect(text).toBe('[VAULT:KEY_SENT] toPeerId=guardian-2');
      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'vault_key_sent', data });
    });

    it('vault key received', () => {
      const data = { fromPeerId: 'guardian-1' };
      const text = formatVaultKeyReceived(data);
      expect(text).toBe('[VAULT:KEY_RECEIVED] fromPeerId=guardian-1');
      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'vault_key_received', data });
    });

    it('db sync sent', () => {
      const data = { seq: 42, peers: 3, sizeKB: 128 };
      const text = formatDbSyncSent(data);
      expect(text).toBe('[DB:SYNC_SENT] seq=42 peers=3 sizeKB=128');
      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'db_sync_sent', data });
    });

    it('db sync received', () => {
      const data = { fromPeerId: 'agent-1', seq: 42 };
      const text = formatDbSyncReceived(data);
      expect(text).toBe('[DB:SYNC_RECEIVED] fromPeerId=agent-1 seq=42');
      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'db_sync_received', data });
    });

    it('db sync rejected', () => {
      const data = { fromPeerId: 'agent-1', reason: 'stale_sequence' };
      const text = formatDbSyncRejected(data);
      expect(text).toBe('[DB:SYNC_REJECTED] fromPeerId=agent-1 reason=stale_sequence');
      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'db_sync_rejected', data });
    });

    it('recovery request', () => {
      const data = { fromPeerId: 'agent-2' };
      const text = formatRecoveryRequest(data);
      expect(text).toBe('[RECOVERY:REQUEST] fromPeerId=agent-2');
      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'recovery_request', data });
    });

    it('recovery served', () => {
      const data = { toPeerId: 'agent-2', seq: 10 };
      const text = formatRecoveryServed(data);
      expect(text).toBe('[RECOVERY:SERVED] toPeerId=agent-2 seq=10');
      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'recovery_served', data });
    });

    it('trust peer added', () => {
      const data = { peerId: 'guardian-5', isSentry: true };
      const text = formatTrustPeerAdded(data);
      expect(text).toBe('[TRUST:PEER_ADDED] peerId=guardian-5 sentry=true');
      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'trust_peer_added', data });
    });

    it('trust peer removed', () => {
      const data = { peerId: 'guardian-5' };
      const text = formatTrustPeerRemoved(data);
      expect(text).toBe('[TRUST:PEER_REMOVED] peerId=guardian-5');
      const parsed = parseProtocolMessage(text);
      expect(parsed).toEqual({ kind: 'trust_peer_removed', data });
    });
  });

  describe('malformed input handling', () => {
    it('returns null for empty string', () => {
      expect(parseProtocolMessage('')).toBeNull();
    });

    it('returns null for random text', () => {
      expect(parseProtocolMessage('hello world')).toBeNull();
    });

    it('returns null for partial prefix', () => {
      expect(parseProtocolMessage('[ANNOUNCE:AGENT]')).toBeNull();
    });

    it('returns null for missing fields in agent announce', () => {
      expect(parseProtocolMessage('[ANNOUNCE:AGENT] endpoint=http://x teeId=abc')).toBeNull();
    });

    it('returns null for missing fields in guardian announce', () => {
      expect(parseProtocolMessage('[ANNOUNCE:GUARDIAN] address=g1')).toBeNull();
    });

    it('returns null for invalid proposal result status', () => {
      expect(parseProtocolMessage('[PROPOSAL:RESULT] id=x status=pending approval=50%')).toBeNull();
    });

    it('returns null for missing percent in proposal new', () => {
      expect(parseProtocolMessage('[PROPOSAL:NEW] id=x type=y threshold=50 deadline=z')).toBeNull();
    });

    it('handles whitespace padding', () => {
      const parsed = parseProtocolMessage('  [DISCOVER:REQUEST]  ');
      expect(parsed).toEqual({ kind: 'discover_request' });
    });
  });
});
