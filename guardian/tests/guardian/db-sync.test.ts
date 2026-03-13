import { describe, it, expect, beforeEach } from 'vitest';
import { createDevSigner } from '../../src/shared/tee-signer.js';
import { TrustStore, type TrustedPeer } from '../../src/shared/trust-store.js';
import { generateVaultKey } from '../../src/shared/vault.js';
import { parsePayload } from '../../src/shared/signed-envelope.js';
import {
  DBSnapshotManager,
  DBSnapshotReceiver,
  createRecoveryRequest,
  createRecoveryResponse,
  type DBSnapshot,
  type DBSyncConfig,
} from '../../src/guardian/db-sync.js';
import type { TEESigner } from '../../src/shared/tee-signer.js';

describe('DB Sync', () => {
  let agentSigner: TEESigner;
  let guardianSigner: TEESigner;
  let vaultKey: Buffer;
  let trustStore: TrustStore;

  function makeSyncConfig(nodeId: string, signer: TEESigner): DBSyncConfig {
    return { nodeId, signer, vaultKey, trustStore };
  }

  beforeEach(() => {
    agentSigner = createDevSigner();
    guardianSigner = createDevSigner();
    vaultKey = generateVaultKey();
    trustStore = new TrustStore();

    // Add both nodes as trusted peers
    const now = Date.now();
    trustStore.addPeer({
      id: 'agent-1',
      ed25519PubkeyBase64: agentSigner.ed25519PubkeyBase64,
      x25519PubkeyBase64: agentSigner.x25519PubkeyBase64,
      attestedAt: now,
      lastVerified: now,
    });
    trustStore.addPeer({
      id: 'guardian-1',
      ed25519PubkeyBase64: guardianSigner.ed25519PubkeyBase64,
      x25519PubkeyBase64: guardianSigner.x25519PubkeyBase64,
      attestedAt: now,
      lastVerified: now,
      endpoint: 'http://localhost:3100',
    });
  });

  describe('DBSnapshotManager', () => {
    it('creates encrypted snapshot with incrementing sequence', async () => {
      const manager = new DBSnapshotManager(makeSyncConfig('agent-1', agentSigner));
      const db = Buffer.from('{"mnemonics":["abandon"]}');

      const env1 = await manager.createSnapshot(db);
      expect(env1.action).toBe('db.snapshot');
      expect(env1.sender).toBe('agent-1');
      expect(manager.currentSequence).toBe(1);

      const env2 = await manager.createSnapshot(db);
      const snap2 = parsePayload<DBSnapshot>(env2);
      expect(snap2.sequenceNum).toBe(2);
      expect(manager.currentSequence).toBe(2);
    });

    it('can set sequence number', () => {
      const manager = new DBSnapshotManager(makeSyncConfig('agent-1', agentSigner));
      manager.setSequence(42);
      expect(manager.currentSequence).toBe(42);
    });

    it('distributes snapshot to trusted peers (skip self)', async () => {
      const manager = new DBSnapshotManager(makeSyncConfig('agent-1', agentSigner));
      const db = Buffer.from('test-db');
      const sent: string[] = [];

      const results = await manager.distributeSnapshot(db, async (peerId, _endpoint, _env) => {
        sent.push(peerId);
        return true;
      });

      // Should send to guardian-1 but not agent-1 (self)
      expect(sent).toEqual(['guardian-1']);
      expect(results).toEqual([{ peerId: 'guardian-1', success: true }]);
    });

    it('handles send failures gracefully', async () => {
      const manager = new DBSnapshotManager(makeSyncConfig('agent-1', agentSigner));
      const db = Buffer.from('test-db');

      const results = await manager.distributeSnapshot(db, async () => {
        throw new Error('network error');
      });

      expect(results).toEqual([{ peerId: 'guardian-1', success: false }]);
    });
  });

  describe('DBSnapshotReceiver', () => {
    it('receives and accepts a valid snapshot', async () => {
      const manager = new DBSnapshotManager(makeSyncConfig('agent-1', agentSigner));
      const receiver = new DBSnapshotReceiver(makeSyncConfig('guardian-1', guardianSigner));

      const db = Buffer.from('crown-jewels-data');
      const envelope = await manager.createSnapshot(db);

      const result = receiver.receiveSnapshot(envelope);
      expect(result.accepted).toBe(true);
      expect(result.sequenceNum).toBe(1);
      expect(receiver.currentSequence).toBe(1);
    });

    it('decrypts and verifies checksum when requested', async () => {
      const manager = new DBSnapshotManager(makeSyncConfig('agent-1', agentSigner));
      const receiver = new DBSnapshotReceiver(makeSyncConfig('guardian-1', guardianSigner));

      const db = Buffer.from('important-data');
      const envelope = await manager.createSnapshot(db);

      const result = receiver.receiveSnapshot(envelope, { decryptAndVerify: true });
      expect(result.accepted).toBe(true);
    });

    it('can decrypt latest snapshot', async () => {
      const manager = new DBSnapshotManager(makeSyncConfig('agent-1', agentSigner));
      const receiver = new DBSnapshotReceiver(makeSyncConfig('guardian-1', guardianSigner));

      const originalDb = Buffer.from('my-secret-database');
      const envelope = await manager.createSnapshot(originalDb);
      receiver.receiveSnapshot(envelope);

      const decrypted = receiver.decryptLatest();
      expect(decrypted).not.toBeNull();
      expect(decrypted!.equals(originalDb)).toBe(true);
    });

    it('rejects untrusted sender', async () => {
      const unknownSigner = createDevSigner();
      const unknownTrust = new TrustStore();
      const manager = new DBSnapshotManager({
        nodeId: 'unknown-node',
        signer: unknownSigner,
        vaultKey,
        trustStore: unknownTrust,
      });
      const receiver = new DBSnapshotReceiver(makeSyncConfig('guardian-1', guardianSigner));

      const envelope = await manager.createSnapshot(Buffer.from('data'));
      const result = receiver.receiveSnapshot(envelope);

      expect(result.accepted).toBe(false);
      expect(result.error).toContain('Unknown sender');
    });

    it('rejects stale sequence number', async () => {
      const manager = new DBSnapshotManager(makeSyncConfig('agent-1', agentSigner));
      const receiver = new DBSnapshotReceiver(makeSyncConfig('guardian-1', guardianSigner));

      // Receive first snapshot
      const env1 = await manager.createSnapshot(Buffer.from('data-1'));
      receiver.receiveSnapshot(env1);

      // Try to receive first snapshot again (same sequence)
      const env2 = await manager.createSnapshot(Buffer.from('data-2'));
      receiver.receiveSnapshot(env2);

      // Manually reset manager sequence to send stale data
      manager.setSequence(0);
      const staleEnv = await manager.createSnapshot(Buffer.from('stale'));
      const result = receiver.receiveSnapshot(staleEnv);

      expect(result.accepted).toBe(false);
      expect(result.error).toContain('Stale snapshot');
    });

    it('returns null when no snapshot available', () => {
      const receiver = new DBSnapshotReceiver(makeSyncConfig('guardian-1', guardianSigner));
      expect(receiver.getLatestSnapshot()).toBeNull();
      expect(receiver.decryptLatest()).toBeNull();
    });
  });

  describe('Recovery flow', () => {
    it('creates a recovery request envelope', async () => {
      const envelope = await createRecoveryRequest('new-agent', agentSigner, 0);
      expect(envelope.action).toBe('db.recovery.request');
      expect(envelope.sender).toBe('new-agent');

      const payload = parsePayload<{ latestKnownSequence: number }>(envelope);
      expect(payload.latestKnownSequence).toBe(0);
    });

    it('creates a recovery response with snapshot', async () => {
      const snapshot: DBSnapshot = {
        encryptedDb: 'base64data',
        iv: 'aabbcc',
        authTag: 'ddeeff',
        sequenceNum: 5,
        checksum: 'sha256hash',
      };

      const envelope = await createRecoveryResponse('guardian-1', guardianSigner, snapshot);
      expect(envelope.action).toBe('db.recovery.response');
      expect(envelope.sender).toBe('guardian-1');
    });

    it('full round-trip: agent → guardian → new agent recovery', async () => {
      // Agent creates snapshots
      const manager = new DBSnapshotManager(makeSyncConfig('agent-1', agentSigner));
      const receiver = new DBSnapshotReceiver(makeSyncConfig('guardian-1', guardianSigner));

      const originalDb = Buffer.from('critical-fund-data');
      const envelope = await manager.createSnapshot(originalDb);
      receiver.receiveSnapshot(envelope);

      // New agent recovers
      const snapshot = receiver.getLatestSnapshot()!;
      const decrypted = receiver.decryptLatest()!;

      expect(decrypted.equals(originalDb)).toBe(true);
      expect(snapshot.sequenceNum).toBe(1);
    });
  });
});
