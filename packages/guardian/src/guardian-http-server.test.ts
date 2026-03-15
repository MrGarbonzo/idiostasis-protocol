import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProtocolDatabase, loadConfig } from '@idiostasis/core';
import type { PingEnvelope, DbSnapshot } from '@idiostasis/core';
import { LivenessMonitor } from './liveness/monitor.js';
import { GuardianHttpServer } from './guardian-http-server.js';
import type { AdmissionPayload } from './http-server.js';
import type { VaultKeyUpdatePayload, OnVaultKeyUpdate } from './guardian-http-server.js';

let server: GuardianHttpServer;
let tmpDir: string;
let db: ProtocolDatabase;
let port: number;

// Find a random high port
function getPort(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

function makeEnvelope(overrides?: Partial<PingEnvelope>): PingEnvelope {
  return {
    teeInstanceId: 'primary-tee',
    timestamp: Date.now(),
    nonce: randomBytes(16).toString('hex'),
    signature: 'dummy-sig',
    ...overrides,
  };
}

async function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'guardian-http-'));
  const vaultKey = new Uint8Array(randomBytes(32));
  db = new ProtocolDatabase(join(tmpDir, 'test.db'), vaultKey);
  const config = loadConfig({ HEARTBEAT_INTERVAL_MS: '100', LIVENESS_FAILURE_THRESHOLD: '3' });
  const succession = { async initiate() {}, isInProgress() { return false; } };
  const liveness = new LivenessMonitor(config, db, succession);

  port = getPort();
  server = new GuardianHttpServer(
    port,
    liveness,
    async (_payload: AdmissionPayload) => {},
    async () => null,
  );
  await server.start();
}

async function cleanup() {
  await server?.stop();
  db?.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
}

describe('GuardianHttpServer', () => {
  afterEach(cleanup);

  it('POST /ping with valid envelope: returns ok', async () => {
    await setup();
    const envelope = makeEnvelope();
    const res = await fetch(`http://localhost:${port}/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    const json = await res.json() as { ok: boolean };
    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
  });

  it('POST /ping with missing fields: returns 400', async () => {
    await setup();
    const res = await fetch(`http://localhost:${port}/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teeInstanceId: 'x' }),
    });
    assert.equal(res.status, 400);
    const json = await res.json() as { ok: boolean; error: string };
    assert.equal(json.ok, false);
  });

  it('POST /recovery without valid envelope header: returns 401', async () => {
    await setup();
    const res = await fetch(`http://localhost:${port}/recovery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 401);
  });

  it('POST /recovery with valid envelope header: returns snapshot shape', async () => {
    await setup();
    const envelope = makeEnvelope();
    const res = await fetch(`http://localhost:${port}/recovery`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-agent-envelope': JSON.stringify(envelope),
      },
      body: '{}',
    });
    assert.equal(res.status, 200);
    const json = await res.json() as { snapshot: DbSnapshot | null };
    assert.ok('snapshot' in json);
  });
});

describe('GuardianHttpServer — vault key update', () => {
  afterEach(cleanup);

  async function setupWithVaultKeyHandler(handler: OnVaultKeyUpdate) {
    tmpDir = mkdtempSync(join(tmpdir(), 'guardian-http-'));
    const vaultKey = new Uint8Array(randomBytes(32));
    db = new ProtocolDatabase(join(tmpDir, 'test.db'), vaultKey);
    const config = loadConfig({ HEARTBEAT_INTERVAL_MS: '100', LIVENESS_FAILURE_THRESHOLD: '3' });
    const succession = { async initiate() {}, isInProgress() { return false; } };
    const liveness = new LivenessMonitor(config, db, succession);

    port = getPort();
    server = new GuardianHttpServer(
      port,
      liveness,
      async (_payload: AdmissionPayload) => {},
      async () => null,
      handler,
    );
    await server.start();
  }

  it('POST /api/vault-key-update with valid envelope: calls handler and returns ok', async () => {
    let receivedPayload: VaultKeyUpdatePayload | null = null;
    await setupWithVaultKeyHandler(async (payload) => {
      receivedPayload = payload;
    });

    const envelope = makeEnvelope();
    const body = {
      wrappedKey: { ciphertext: 'abc', iv: 'def', authTag: 'ghi' },
      snapshot: { encryptedDb: 'x', iv: 'y', authTag: 'z', sequenceNum: 1, checksum: 'c', signedBy: 's', signature: 'sig', timestamp: Date.now() },
      primaryX25519PublicKey: 'base64key',
    };

    const res = await fetch(`http://localhost:${port}/api/vault-key-update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-agent-envelope': JSON.stringify(envelope),
      },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    const json = await res.json() as { ok: boolean };
    assert.equal(json.ok, true);
    assert.ok(receivedPayload);
    assert.equal(receivedPayload!.wrappedKey.ciphertext, 'abc');
  });

  it('POST /api/vault-key-update without valid envelope: returns 401', async () => {
    await setupWithVaultKeyHandler(async () => {});

    const res = await fetch(`http://localhost:${port}/api/vault-key-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wrappedKey: {}, snapshot: {} }),
    });
    assert.equal(res.status, 401);
  });
});
