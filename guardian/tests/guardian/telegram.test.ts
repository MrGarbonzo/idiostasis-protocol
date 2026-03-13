import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  formatDiscoverRequest,
  formatDiscoverResponse,
  formatAgentAnnounce,
  formatGuardianAnnounce,
  parseProtocolMessage,
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

describe('Guardian Telegram Bot (protocol logic)', () => {
  describe('protocol message handling', () => {
    it('parses DISCOVER:REQUEST and generates valid response', () => {
      const request = formatDiscoverRequest();
      const parsed = parseProtocolMessage(request);
      expect(parsed).toEqual({ kind: 'discover_request' });

      // Simulate guardian response
      const response = formatDiscoverResponse({
        address: 'guardian-1',
        endpoint: 'http://g1:3100',
        isSentry: true,
      });

      const parsedResponse = parseProtocolMessage(response);
      expect(parsedResponse).not.toBeNull();
      expect(parsedResponse!.kind).toBe('discover_response');
      if (parsedResponse!.kind === 'discover_response') {
        expect(parsedResponse!.data.address).toBe('guardian-1');
        expect(parsedResponse!.data.endpoint).toBe('http://g1:3100');
        expect(parsedResponse!.data.isSentry).toBe(true);
      }
    });

    it('parses ANNOUNCE:AGENT and extracts peer info', () => {
      const announce = formatAgentAnnounce({
        endpoint: 'http://agent:3000',
        teeId: 'tee-123',
        codeHash: 'abc',
      });

      const parsed = parseProtocolMessage(announce);
      expect(parsed).not.toBeNull();
      expect(parsed!.kind).toBe('agent_announce');
      if (parsed!.kind === 'agent_announce') {
        expect(parsed!.data.endpoint).toBe('http://agent:3000');
        expect(parsed!.data.teeId).toBe('tee-123');
        expect(parsed!.data.codeHash).toBe('abc');
      }
    });

    it('parses ANNOUNCE:GUARDIAN and extracts peer info', () => {
      const announce = formatGuardianAnnounce({
        address: 'sentry-1',
        endpoint: 'http://s1:3100',
        isSentry: true,
      });

      const parsed = parseProtocolMessage(announce);
      expect(parsed).not.toBeNull();
      expect(parsed!.kind).toBe('guardian_announce');
      if (parsed!.kind === 'guardian_announce') {
        expect(parsed!.data.address).toBe('sentry-1');
        expect(parsed!.data.isSentry).toBe(true);
      }
    });

    it('ignores non-protocol messages', () => {
      expect(parseProtocolMessage('Hello, how are you?')).toBeNull();
      expect(parseProtocolMessage('/start')).toBeNull();
      expect(parseProtocolMessage('What is the fund status?')).toBeNull();
    });

    it('parses trust event messages', () => {
      const cases = [
        { fn: () => formatAttestationRequest({ peerId: 'g2', pubkey: 'abcd1234' }), kind: 'attestation_request' },
        { fn: () => formatAttestationVerified({ peerId: 'g2', pubkey: 'abcd1234', isSentry: false }), kind: 'attestation_verified' },
        { fn: () => formatAttestationRejected({ peerId: 'g3', reason: 'bad_quote' }), kind: 'attestation_rejected' },
        { fn: () => formatVaultKeySent({ toPeerId: 'g2' }), kind: 'vault_key_sent' },
        { fn: () => formatVaultKeyReceived({ fromPeerId: 'g1' }), kind: 'vault_key_received' },
        { fn: () => formatDbSyncSent({ seq: 1, peers: 2, sizeKB: 64 }), kind: 'db_sync_sent' },
        { fn: () => formatDbSyncReceived({ fromPeerId: 'agent-1', seq: 5 }), kind: 'db_sync_received' },
        { fn: () => formatDbSyncRejected({ fromPeerId: 'agent-1', reason: 'stale' }), kind: 'db_sync_rejected' },
        { fn: () => formatRecoveryRequest({ fromPeerId: 'agent-2' }), kind: 'recovery_request' },
        { fn: () => formatRecoveryServed({ toPeerId: 'agent-2', seq: 10 }), kind: 'recovery_served' },
        { fn: () => formatTrustPeerAdded({ peerId: 'g5', isSentry: true }), kind: 'trust_peer_added' },
        { fn: () => formatTrustPeerRemoved({ peerId: 'g5' }), kind: 'trust_peer_removed' },
      ];

      for (const { fn, kind } of cases) {
        const text = fn();
        const parsed = parseProtocolMessage(text);
        expect(parsed).not.toBeNull();
        expect(parsed!.kind).toBe(kind);
      }
    });
  });

  describe('DM command parsing', () => {
    it('parses /vote command arguments', () => {
      const text = '/vote prop-abc123 approve';
      const args = text.split(/\s+/).slice(1);
      expect(args).toEqual(['prop-abc123', 'approve']);
    });

    it('parses /delegate command arguments', () => {
      const text = '/delegate sentry-1';
      const args = text.split(/\s+/).slice(1);
      expect(args).toEqual(['sentry-1']);
    });

    it('rejects invalid vote decision', () => {
      const text = '/vote prop-abc123 maybe';
      const args = text.split(/\s+/).slice(1);
      const decision = args[1];
      expect(decision !== 'approve' && decision !== 'reject').toBe(true);
    });
  });

  describe('discovery flow simulation', () => {
    it('full discovery round-trip', () => {
      // Agent sends discover request
      const request = formatDiscoverRequest();
      expect(parseProtocolMessage(request)?.kind).toBe('discover_request');

      // Three guardians respond
      const responses = [
        { address: 'g1', endpoint: 'http://g1:3100', isSentry: false },
        { address: 'g2', endpoint: 'http://g2:3100', isSentry: false },
        { address: 's1', endpoint: 'http://s1:3100', isSentry: true },
      ];

      const discovered = new Map<string, { address: string; endpoint: string; isSentry: boolean }>();
      for (const r of responses) {
        const text = formatDiscoverResponse(r);
        const parsed = parseProtocolMessage(text);
        if (parsed?.kind === 'discover_response') {
          discovered.set(parsed.data.address, parsed.data);
        }
      }

      expect(discovered.size).toBe(3);
      expect(discovered.get('s1')?.isSentry).toBe(true);
      expect(discovered.get('g1')?.endpoint).toBe('http://g1:3100');
    });
  });
});
