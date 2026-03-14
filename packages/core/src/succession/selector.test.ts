import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectSuccessor } from './selector.js';
import type { BackupAgentRecord } from '../interfaces.js';

function makeBackup(overrides: Partial<BackupAgentRecord> & { id: string }): BackupAgentRecord {
  return {
    networkAddress: `${overrides.id}.test:8080`,
    teeInstanceId: `tee-${overrides.id}`,
    rtmr3: 'abc123',
    registeredAt: new Date('2026-01-01'),
    heartbeatStreak: 0,
    lastHeartbeatAt: new Date(),
    status: 'standby',
    ...overrides,
  };
}

describe('selectSuccessor', () => {
  it('returns null for empty list', () => {
    assert.equal(selectSuccessor([]), null);
  });

  it('returns null if all agents are inactive', () => {
    const agents = [
      makeBackup({ id: 'a', status: 'inactive' }),
      makeBackup({ id: 'b', status: 'inactive' }),
    ];
    assert.equal(selectSuccessor(agents), null);
  });

  it('selects highest streak agent', () => {
    const agents = [
      makeBackup({ id: 'low', heartbeatStreak: 5 }),
      makeBackup({ id: 'high', heartbeatStreak: 20 }),
      makeBackup({ id: 'mid', heartbeatStreak: 10 }),
    ];
    const winner = selectSuccessor(agents)!;
    assert.equal(winner.id, 'high');
  });

  it('tiebreaker 1: equal streak → earlier registeredAt wins', () => {
    const agents = [
      makeBackup({ id: 'newer', heartbeatStreak: 10, registeredAt: new Date('2026-03-01') }),
      makeBackup({ id: 'older', heartbeatStreak: 10, registeredAt: new Date('2026-01-01') }),
    ];
    const winner = selectSuccessor(agents)!;
    assert.equal(winner.id, 'older');
  });

  it('tiebreaker 2: equal streak + equal registeredAt → lexically lower teeInstanceId wins', () => {
    const sameTime = new Date('2026-01-01');
    const agents = [
      makeBackup({ id: 'z', heartbeatStreak: 10, registeredAt: sameTime, teeInstanceId: 'tee-zzz' }),
      makeBackup({ id: 'a', heartbeatStreak: 10, registeredAt: sameTime, teeInstanceId: 'tee-aaa' }),
    ];
    const winner = selectSuccessor(agents)!;
    assert.equal(winner.teeInstanceId, 'tee-aaa');
  });

  it('all three tiebreakers applied in correct priority order', () => {
    const sameTime = new Date('2026-01-01');
    const agents = [
      // Highest streak wins, regardless of other fields
      makeBackup({ id: 'a', heartbeatStreak: 100, registeredAt: new Date('2026-06-01'), teeInstanceId: 'tee-zzz' }),
      // Lower streak, earlier registration — should not win
      makeBackup({ id: 'b', heartbeatStreak: 50, registeredAt: new Date('2026-01-01'), teeInstanceId: 'tee-aaa' }),
      // Same streak as 'a' but later — loses on tiebreaker 2
      makeBackup({ id: 'c', heartbeatStreak: 100, registeredAt: new Date('2026-07-01'), teeInstanceId: 'tee-aaa' }),
    ];
    const winner = selectSuccessor(agents)!;
    // 'a' and 'c' both have streak 100. 'a' has earlier registeredAt → wins
    assert.equal(winner.id, 'a');
  });

  it('is pure: same input always produces same output', () => {
    const agents = [
      makeBackup({ id: 'x', heartbeatStreak: 5 }),
      makeBackup({ id: 'y', heartbeatStreak: 10 }),
    ];
    const result1 = selectSuccessor(agents);
    const result2 = selectSuccessor(agents);
    assert.deepStrictEqual(result1, result2);
  });

  it('filters out inactive agents before selecting', () => {
    const agents = [
      makeBackup({ id: 'inactive-high', heartbeatStreak: 100, status: 'inactive' }),
      makeBackup({ id: 'standby-low', heartbeatStreak: 1, status: 'standby' }),
    ];
    const winner = selectSuccessor(agents)!;
    assert.equal(winner.id, 'standby-low');
  });
});
