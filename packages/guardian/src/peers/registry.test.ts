import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PeerRegistry } from './registry.js';
import type { PeerRecord } from './registry.js';

let registry: PeerRegistry;
let tmpDir: string;

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'idiostasis-peers-'));
  registry = new PeerRegistry(join(tmpDir, 'peers.db'));
}

function teardown() {
  registry.close();
  rmSync(tmpDir, { recursive: true, force: true });
}

function makePeer(id: string, lastSeenAt?: number): PeerRecord {
  return {
    id,
    networkAddress: `${id}.test:8080`,
    teeInstanceId: `tee-${id}`,
    rtmr3: 'abc123',
    discoveredAt: Date.now() - 60_000,
    lastSeenAt: lastSeenAt ?? Date.now(),
    discoveredVia: 'direct',
  };
}

describe('PeerRegistry', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('upsert is idempotent', () => {
    const peer = makePeer('p1');
    registry.upsertPeer(peer);
    registry.upsertPeer({ ...peer, networkAddress: 'updated.test:8080' });
    const result = registry.getPeer('p1');
    assert.ok(result);
    assert.equal(result.networkAddress, 'updated.test:8080');
    assert.equal(registry.listPeers().length, 1);
  });

  it('pruneStale removes peers beyond threshold, returns correct count', () => {
    const oldTime = Date.now() - 3_600_000; // 1 hour ago
    registry.upsertPeer(makePeer('stale1', oldTime));
    registry.upsertPeer(makePeer('stale2', oldTime));
    registry.upsertPeer(makePeer('fresh', Date.now()));

    const pruned = registry.pruneStale(1_800_000); // 30 min threshold
    assert.equal(pruned, 2);
    assert.equal(registry.listPeers().length, 1);
    assert.equal(registry.listPeers()[0].id, 'fresh');
  });

  it('pruneStale keeps peers within threshold', () => {
    registry.upsertPeer(makePeer('recent', Date.now()));
    registry.upsertPeer(makePeer('also-recent', Date.now() - 1_000));

    const pruned = registry.pruneStale(1_800_000);
    assert.equal(pruned, 0);
    assert.equal(registry.listPeers().length, 2);
  });
});
