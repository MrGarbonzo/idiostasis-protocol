import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MoltbookStateAdapter } from '../state/adapter.js';
import { MoltbookHealthAdapter } from './adapter.js';
import { MoltbookClient } from '../moltbook/client.js';

function createHealthAdapter(overrides?: {
  verifyResult?: boolean;
  sessionExpiresAt?: string | null;
  pingResult?: { ok: boolean };
  pingThrows?: boolean;
}): MoltbookHealthAdapter {
  const stateAdapter = new MoltbookStateAdapter('bot', 'Bot');

  if (overrides?.sessionExpiresAt !== undefined) {
    if (overrides.sessionExpiresAt !== null) {
      stateAdapter.updateCredentials('tok', overrides.sessionExpiresAt);
    }
  }

  // Override verify if needed
  if (overrides?.verifyResult === false) {
    stateAdapter.verify = async () => false;
  }

  const client = new MoltbookClient('http://test.local');

  if (overrides?.pingResult !== undefined) {
    client.ping = async () => overrides.pingResult!;
  }
  if (overrides?.pingThrows) {
    client.ping = async () => { throw new Error('connection refused'); };
  }

  return new MoltbookHealthAdapter(stateAdapter, client);
}

describe('MoltbookHealthAdapter', () => {
  it('returns critical when verify fails', async () => {
    const adapter = createHealthAdapter({ verifyResult: false });
    const result = await adapter.check();
    assert.equal(result.healthy, false);
    assert.equal(result.severity, 'critical');
    assert.match(result.reason!, /state integrity/);
  });

  it('returns warning when session is expired', async () => {
    const adapter = createHealthAdapter({
      sessionExpiresAt: '2020-01-01T00:00:00Z',
    });
    const result = await adapter.check();
    assert.equal(result.healthy, false);
    assert.equal(result.severity, 'warning');
    assert.match(result.reason!, /session expired/);
  });

  it('returns warning when session is expiring soon', async () => {
    const soon = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min from now
    const adapter = createHealthAdapter({ sessionExpiresAt: soon });
    const result = await adapter.check();
    assert.equal(result.severity, 'warning');
    assert.match(result.reason!, /expiring soon/);
  });

  it('returns warning when ping returns not ok', async () => {
    const adapter = createHealthAdapter({ pingResult: { ok: false } });
    const result = await adapter.check();
    assert.equal(result.healthy, false);
    assert.equal(result.severity, 'warning');
    assert.match(result.reason!, /ping/);
  });

  it('returns warning when ping throws', async () => {
    const adapter = createHealthAdapter({ pingThrows: true });
    const result = await adapter.check();
    assert.equal(result.healthy, false);
    assert.equal(result.severity, 'warning');
    assert.match(result.reason!, /ping failed/);
  });

  it('returns ok when all checks pass', async () => {
    const adapter = createHealthAdapter();
    const result = await adapter.check();
    assert.equal(result.healthy, true);
    assert.equal(result.severity, 'ok');
  });

  it('checks in priority order — critical before warning', async () => {
    // If verify fails, we get critical, even if session is also expired
    const adapter = createHealthAdapter({
      verifyResult: false,
      sessionExpiresAt: '2020-01-01T00:00:00Z',
    });
    const result = await adapter.check();
    assert.equal(result.severity, 'critical');
  });
});
