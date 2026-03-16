import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, generateKeyPairSync, sign as ed25519Sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProtocolDatabase } from '../database/db.js';
import { SnapshotManager } from '../database/snapshot.js';
import { AdmissionService } from './admission.js';
import type { AdmissionRequest } from './admission.js';
import { KeyExchangeSession } from '../vault/exchange.js';
import { loadConfig } from '../config.js';
import type { ProtocolConfig, AttestationProvider, AttestationResult } from '../interfaces.js';

let db: ProtocolDatabase;
let tmpDir: string;
let config: ProtocolConfig;
let vaultKey: Uint8Array;
let admissionService: AdmissionService;
let snapshotManager: SnapshotManager;

const dummySigner = async (_data: Uint8Array) => new Uint8Array(64);

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'idiostasis-adm-'));
  vaultKey = new Uint8Array(randomBytes(32));
  db = new ProtocolDatabase(join(tmpDir, 'test.db'), vaultKey);
  config = loadConfig({
    GUARDIAN_APPROVED_RTMR3: 'guardian-rtmr3-abc',
    AGENT_APPROVED_RTMR3: 'agent-rtmr3-xyz',
  });
  db.setConfig('agent_rtmr3', 'agent-rtmr3-xyz');
  snapshotManager = new SnapshotManager(db, vaultKey, 'primary-tee');
  admissionService = new AdmissionService(db, config, vaultKey, snapshotManager, dummySigner);
}

function teardown() {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
}

/** Create a valid admission request with a real Ed25519 signature. */
async function makeValidRequest(
  role: 'guardian' | 'backup_agent',
  overrides?: Partial<AdmissionRequest>,
): Promise<AdmissionRequest> {
  // Generate real X25519 keypair
  const session = await KeyExchangeSession.generate();
  const keys = session.getPublicKeys();

  // Generate real Ed25519 keypair and sign x25519 public key
  const { publicKey: ed25519Pub, privateKey: ed25519Priv } = generateKeyPairSync('ed25519');
  const signature = ed25519Sign(null, keys.x25519, ed25519Priv);
  const derBuf = ed25519Pub.export({ type: 'spki', format: 'der' });
  const ed25519PublicRaw = new Uint8Array(derBuf.subarray(derBuf.length - 32));

  return {
    role,
    networkAddress: 'node.test:8080',
    teeInstanceId: `tee-${randomBytes(8).toString('hex')}`,
    rtmr3: role === 'guardian' ? 'guardian-rtmr3-abc' : 'agent-rtmr3-xyz',
    x25519PublicKey: keys.x25519,
    ed25519PublicKey: ed25519PublicRaw,
    ed25519Signature: new Uint8Array(signature),
    nonce: randomBytes(16).toString('hex'),
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('AdmissionService', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('rejects replayed nonce', async () => {
    const req = await makeValidRequest('guardian');
    const result1 = await admissionService.handleAdmissionRequest(req);
    assert.equal(result1.accepted, true);

    const result2 = await admissionService.handleAdmissionRequest(req);
    assert.equal(result2.accepted, false);
    assert.equal(result2.reason, 'replay');
  });

  it('rejects stale timestamp (> 60s)', async () => {
    const req = await makeValidRequest('guardian', {
      timestamp: Date.now() - 120_000, // 2 minutes ago
    });
    const result = await admissionService.handleAdmissionRequest(req);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'stale_timestamp');
  });

  it('rejects invalid ed25519 signature', async () => {
    const req = await makeValidRequest('guardian', {
      ed25519Signature: new Uint8Array(64), // Zeroed — invalid
    });
    const result = await admissionService.handleAdmissionRequest(req);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'invalid_signature');
  });

  it('rejects RTMR3 mismatch for guardian role', async () => {
    const req = await makeValidRequest('guardian', {
      rtmr3: 'wrong-guardian-rtmr3',
    });
    const result = await admissionService.handleAdmissionRequest(req);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'rtmr3_mismatch');
  });

  it('rejects RTMR3 mismatch for backup_agent role', async () => {
    const req = await makeValidRequest('backup_agent', {
      rtmr3: 'wrong-agent-rtmr3',
    });
    const result = await admissionService.handleAdmissionRequest(req);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'rtmr3_mismatch');
  });

  it('accepts valid guardian: writes to DB, returns vault key + snapshot', async () => {
    const req = await makeValidRequest('guardian');
    const result = await admissionService.handleAdmissionRequest(req);

    assert.equal(result.accepted, true);
    assert.ok(result.vaultKey, 'guardian must receive vault key');
    assert.ok(result.dbSnapshot, 'guardian must receive db snapshot');
    assert.ok(result.primaryX25519PublicKey);
    assert.ok(result.primaryEd25519PublicKey);

    // Verify written to DB
    const guardian = db.getGuardian(req.teeInstanceId);
    assert.ok(guardian);
    assert.equal(guardian.status, 'active');
    assert.equal(guardian.networkAddress, req.networkAddress);
  });

  it('accepts valid backup_agent: writes to DB, no vault key in response', async () => {
    const req = await makeValidRequest('backup_agent');
    const result = await admissionService.handleAdmissionRequest(req);

    assert.equal(result.accepted, true);
    assert.equal(result.vaultKey, undefined, 'backup_agent must NOT receive vault key');
    assert.equal(result.dbSnapshot, undefined, 'backup_agent must NOT receive snapshot');
    assert.ok(result.primaryX25519PublicKey);

    // Verify written to DB
    const backup = db.getBackupAgent(req.teeInstanceId);
    assert.ok(backup);
    assert.equal(backup.status, 'standby');
    assert.equal(backup.heartbeatStreak, 0);
  });

  it('guardian admission: provisionedBy is external', async () => {
    const req = await makeValidRequest('guardian');
    await admissionService.handleAdmissionRequest(req);
    const guardian = db.getGuardian(req.teeInstanceId);
    assert.equal(guardian!.provisionedBy, 'external');
  });

  it('guardian admission logs ADMISSION event', async () => {
    const req = await makeValidRequest('guardian');
    await admissionService.handleAdmissionRequest(req);
    const events = db.getRecentEvents(1);
    assert.equal(events[0].eventType, 'admission');
    assert.ok(events[0].detail!.startsWith('guardian:'));
  });

  it('backup agent admission logs ADMISSION event', async () => {
    const req = await makeValidRequest('backup_agent');
    await admissionService.handleAdmissionRequest(req);
    const events = db.getRecentEvents(1);
    assert.equal(events[0].eventType, 'admission');
    assert.ok(events[0].detail!.startsWith('backup:'));
  });
});

describe('AdmissionService — guardian RTMR3 auto-lock', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'idiostasis-adm-'));
    vaultKey = new Uint8Array(randomBytes(32));
    db = new ProtocolDatabase(join(tmpDir, 'test.db'), vaultKey);
    // Empty approved list — triggers auto-lock behavior
    config = loadConfig({
      GUARDIAN_APPROVED_RTMR3: '',
      AGENT_APPROVED_RTMR3: 'agent-rtmr3-xyz',
    });
    db.setConfig('agent_rtmr3', 'agent-rtmr3-xyz');
    snapshotManager = new SnapshotManager(db, vaultKey, 'primary-tee');
    admissionService = new AdmissionService(db, config, vaultKey, snapshotManager, dummySigner);
  });
  afterEach(teardown);

  it('empty approved list + first guardian: accepted, RTMR3 stored in DB', async () => {
    const req = await makeValidRequest('guardian', { rtmr3: 'first-guardian-rtmr3' });
    const result = await admissionService.handleAdmissionRequest(req);
    assert.equal(result.accepted, true);
    assert.equal(db.getConfig('guardian_rtmr3'), 'first-guardian-rtmr3');
  });

  it('empty approved list + second guardian matching locked value: accepted', async () => {
    // First guardian locks
    const req1 = await makeValidRequest('guardian', { rtmr3: 'locked-rtmr3' });
    await admissionService.handleAdmissionRequest(req1);

    // Second guardian with same RTMR3
    const req2 = await makeValidRequest('guardian', { rtmr3: 'locked-rtmr3' });
    const result = await admissionService.handleAdmissionRequest(req2);
    assert.equal(result.accepted, true);
  });

  it('empty approved list + second guardian with different RTMR3: rejected', async () => {
    // First guardian locks
    const req1 = await makeValidRequest('guardian', { rtmr3: 'locked-rtmr3' });
    await admissionService.handleAdmissionRequest(req1);

    // Second guardian with different RTMR3
    const req2 = await makeValidRequest('guardian', { rtmr3: 'different-rtmr3' });
    const result = await admissionService.handleAdmissionRequest(req2);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'rtmr3_mismatch');
  });

  it('non-empty approved list: existing behavior unchanged', async () => {
    // Reconfigure with explicit list
    const explicitConfig = loadConfig({
      GUARDIAN_APPROVED_RTMR3: 'explicit-rtmr3',
      AGENT_APPROVED_RTMR3: 'agent-rtmr3-xyz',
    });
    const svc = new AdmissionService(db, explicitConfig, vaultKey, snapshotManager, dummySigner);

    const req = await makeValidRequest('guardian', { rtmr3: 'explicit-rtmr3' });
    const result = await svc.handleAdmissionRequest(req);
    assert.equal(result.accepted, true);

    // DB should NOT have guardian_rtmr3 set (auto-lock is only for empty list)
    assert.equal(db.getConfig('guardian_rtmr3'), null);
  });

  it('first guardian lock logs WARN with teeInstanceId', async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      const req = await makeValidRequest('guardian', { rtmr3: 'log-test-rtmr3' });
      await admissionService.handleAdmissionRequest(req);
      const lockLog = warnings.find(w => w.includes('FIRST GUARDIAN'));
      assert.ok(lockLog, 'should log FIRST GUARDIAN warning');
      assert.ok(lockLog!.includes(req.teeInstanceId), 'log should include teeInstanceId');
      assert.ok(lockLog!.includes('log-test-rtmr3'.slice(0, 16)), 'log should include RTMR3 prefix');
    } finally {
      console.warn = origWarn;
    }
  });
});

describe('AdmissionService — attestation verification', () => {
  beforeEach(setup);
  afterEach(teardown);

  function createMockProvider(overrides?: {
    fetchQuote?: (domain: string) => Promise<string>;
    verifyQuote?: (quote: string) => Promise<AttestationResult>;
  }): AttestationProvider {
    return {
      fetchQuote: overrides?.fetchQuote ?? (async () => 'mock-quote-hex'),
      verifyQuote: overrides?.verifyQuote ?? (async () => ({
        rtmr3: 'guardian-rtmr3-abc',
        valid: true,
        tcbStatus: 'UpToDate',
      })),
    };
  }

  it('calls attestationProvider.fetchQuote with req.domain in production mode', async () => {
    let capturedDomain = '';
    const provider = createMockProvider({
      fetchQuote: async (domain: string) => { capturedDomain = domain; return 'mock-quote'; },
    });
    const svc = new AdmissionService(db, config, vaultKey, snapshotManager, dummySigner, provider);
    const req = await makeValidRequest('guardian', { domain: 'test.vm.scrtlabs.com', rtmr3: undefined });
    await svc.handleAdmissionRequest(req);
    assert.equal(capturedDomain, 'test.vm.scrtlabs.com');
  });

  it('returns attestation_failed if fetchQuote throws', async () => {
    const provider = createMockProvider({
      fetchQuote: async () => { throw new Error('network error'); },
    });
    const svc = new AdmissionService(db, config, vaultKey, snapshotManager, dummySigner, provider);
    const req = await makeValidRequest('guardian', { domain: 'bad.vm.scrtlabs.com', rtmr3: undefined });
    const result = await svc.handleAdmissionRequest(req);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'attestation_failed');
  });

  it('returns attestation_invalid if verifyQuote returns valid: false', async () => {
    const provider = createMockProvider({
      verifyQuote: async () => ({ rtmr3: 'whatever', valid: false, tcbStatus: 'Revoked' }),
    });
    const svc = new AdmissionService(db, config, vaultKey, snapshotManager, dummySigner, provider);
    const req = await makeValidRequest('guardian', { domain: 'revoked.vm.scrtlabs.com', rtmr3: undefined });
    const result = await svc.handleAdmissionRequest(req);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'attestation_invalid');
  });

  it('uses PCCS-verified RTMR3, not self-reported rtmr3', async () => {
    const provider = createMockProvider({
      verifyQuote: async () => ({ rtmr3: 'guardian-rtmr3-abc', valid: true, tcbStatus: 'UpToDate' }),
    });
    const svc = new AdmissionService(db, config, vaultKey, snapshotManager, dummySigner, provider);
    // Self-reported rtmr3 is wrong, but PCCS returns the correct one
    const req = await makeValidRequest('guardian', {
      domain: 'verified.vm.scrtlabs.com',
      rtmr3: 'wrong-self-reported-value',
    });
    const result = await svc.handleAdmissionRequest(req);
    assert.equal(result.accepted, true);

    // Verify DB record has PCCS-verified RTMR3, not self-reported
    const guardian = db.getGuardian(req.teeInstanceId);
    assert.equal(guardian!.rtmr3, 'guardian-rtmr3-abc');
  });

  it('skips attestation provider in DEV_MODE=true', async () => {
    const original = process.env.DEV_MODE;
    process.env.DEV_MODE = 'true';
    try {
      let providerCalled = false;
      const provider = createMockProvider({
        fetchQuote: async () => { providerCalled = true; return 'quote'; },
      });
      const svc = new AdmissionService(db, config, vaultKey, snapshotManager, dummySigner, provider);
      const req = await makeValidRequest('guardian');
      const result = await svc.handleAdmissionRequest(req);
      assert.equal(result.accepted, true);
      assert.equal(providerCalled, false, 'provider should not be called in DEV_MODE');
    } finally {
      if (original === undefined) delete process.env.DEV_MODE;
      else process.env.DEV_MODE = original;
    }
  });

  it('returns missing_domain if domain is empty in production mode', async () => {
    const provider = createMockProvider();
    const svc = new AdmissionService(db, config, vaultKey, snapshotManager, dummySigner, provider);
    const req = await makeValidRequest('guardian', { domain: '', rtmr3: undefined });
    const result = await svc.handleAdmissionRequest(req);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'missing_domain');
  });

  it('returns missing_domain if domain is undefined in production mode', async () => {
    const provider = createMockProvider();
    const svc = new AdmissionService(db, config, vaultKey, snapshotManager, dummySigner, provider);
    const req = await makeValidRequest('guardian', { domain: undefined, rtmr3: undefined });
    const result = await svc.handleAdmissionRequest(req);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'missing_domain');
  });
});
