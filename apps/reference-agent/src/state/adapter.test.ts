import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MoltbookStateAdapter } from './adapter.js';

describe('MoltbookStateAdapter', () => {
  it('round-trips state through serialize/deserialize', async () => {
    const adapter = new MoltbookStateAdapter('testbot', 'Test Bot');
    const serialized = await adapter.serialize();
    assert.ok(serialized instanceof Uint8Array);

    const adapter2 = new MoltbookStateAdapter('other', 'Other');
    await adapter2.deserialize(serialized);
    const state = adapter2.getState();
    assert.equal(state.agentHandle, 'testbot');
    assert.equal(state.displayName, 'Test Bot');
  });

  it('throws on missing agentHandle', async () => {
    const adapter = new MoltbookStateAdapter('x', 'X');
    const bad = new TextEncoder().encode(JSON.stringify({ createdAt: '2026-01-01' }));
    await assert.rejects(() => adapter.deserialize(bad), /missing agentHandle/);
  });

  it('throws on missing createdAt', async () => {
    const adapter = new MoltbookStateAdapter('x', 'X');
    const bad = new TextEncoder().encode(JSON.stringify({ agentHandle: 'test' }));
    await assert.rejects(() => adapter.deserialize(bad), /missing createdAt/);
  });

  it('onSuccessionComplete increments recoveryCount', async () => {
    const adapter = new MoltbookStateAdapter('bot', 'Bot');
    assert.equal(adapter.getState().recoveryCount, 0);

    await adapter.onSuccessionComplete();
    assert.equal(adapter.getState().recoveryCount, 1);
    assert.ok(adapter.getState().lastRecoveryAt !== null);

    await adapter.onSuccessionComplete();
    assert.equal(adapter.getState().recoveryCount, 2);
  });

  it('verify returns true for valid state', async () => {
    const adapter = new MoltbookStateAdapter('bot', 'Bot');
    assert.equal(await adapter.verify(), true);
  });

  it('verify returns false for empty agentHandle', async () => {
    const adapter = new MoltbookStateAdapter('bot', 'Bot');
    // Deserialize state with empty handle
    const bad = new TextEncoder().encode(JSON.stringify({
      agentHandle: '',
      displayName: 'Bot',
      createdAt: '2026-01-01',
      recoveryCount: 0,
      lastRecoveryAt: null,
      credentials: { sessionToken: null, sessionExpiresAt: null },
    }));
    // Empty string passes the type check but fails the length check in verify
    // Need to bypass the deserialize validation — set state directly via round-trip
    const adapter2 = new MoltbookStateAdapter('', 'Bot');
    assert.equal(await adapter2.verify(), false);
  });

  it('updateCredentials sets session token and expiry', () => {
    const adapter = new MoltbookStateAdapter('bot', 'Bot');
    adapter.updateCredentials('tok-123', '2026-12-31T00:00:00Z');
    const state = adapter.getState();
    assert.equal(state.credentials.sessionToken, 'tok-123');
    assert.equal(state.credentials.sessionExpiresAt, '2026-12-31T00:00:00Z');
  });
});
