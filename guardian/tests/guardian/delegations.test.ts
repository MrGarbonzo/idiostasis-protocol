import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../../src/shared/db.js';
import { DelegationTracker } from '../../src/guardian/delegations.js';
import type Database from 'better-sqlite3';

describe('DelegationTracker', () => {
  let db: Database.Database;
  let tracker: DelegationTracker;

  beforeEach(() => {
    db = createDatabase(':memory:');
    tracker = new DelegationTracker(db, 'http://localhost:3000');
  });

  it('creates a delegation', () => {
    const id = tracker.create({
      delegatorTgId: 'tg-user-1',
      sentryAddress: 'sentry-1',
      nftTokenIds: [1, 2, 3],
      totalValue: 50000, // 500.00
      signature: 'sig-abc',
      expiresAt: '2099-12-31T23:59:59',
    });

    expect(id).toBe(1);
    const delegation = tracker.getById(id);
    expect(delegation).toBeDefined();
    expect(delegation!.delegator_tg_id).toBe('tg-user-1');
    expect(delegation!.sentry_address).toBe('sentry-1');
    expect(JSON.parse(delegation!.nft_token_ids)).toEqual([1, 2, 3]);
    expect(delegation!.total_value).toBe(50000);
    expect(delegation!.is_active).toBe(1);
  });

  it('lists delegations for a sentry', () => {
    tracker.create({
      delegatorTgId: 'tg-1',
      sentryAddress: 'sentry-1',
      nftTokenIds: [1],
      totalValue: 10000,
      signature: 'sig1',
      expiresAt: '2099-12-31',
    });
    tracker.create({
      delegatorTgId: 'tg-2',
      sentryAddress: 'sentry-1',
      nftTokenIds: [2],
      totalValue: 20000,
      signature: 'sig2',
      expiresAt: '2099-12-31',
    });
    tracker.create({
      delegatorTgId: 'tg-3',
      sentryAddress: 'sentry-2',
      nftTokenIds: [3],
      totalValue: 30000,
      signature: 'sig3',
      expiresAt: '2099-12-31',
    });

    const forSentry1 = tracker.getForSentry('sentry-1');
    expect(forSentry1).toHaveLength(2);
  });

  it('lists delegations by delegator', () => {
    tracker.create({
      delegatorTgId: 'tg-1',
      sentryAddress: 'sentry-1',
      nftTokenIds: [1],
      totalValue: 10000,
      signature: 'sig1',
      expiresAt: '2099-12-31',
    });
    tracker.create({
      delegatorTgId: 'tg-1',
      sentryAddress: 'sentry-2',
      nftTokenIds: [2],
      totalValue: 20000,
      signature: 'sig2',
      expiresAt: '2099-12-31',
    });

    const byDelegator = tracker.getByDelegator('tg-1');
    expect(byDelegator).toHaveLength(2);
  });

  it('revokes a delegation (only by owner)', () => {
    const id = tracker.create({
      delegatorTgId: 'tg-1',
      sentryAddress: 'sentry-1',
      nftTokenIds: [1],
      totalValue: 10000,
      signature: 'sig1',
      expiresAt: '2099-12-31',
    });

    // Wrong delegator can't revoke
    expect(tracker.revoke(id, 'tg-wrong')).toBe(false);
    expect(tracker.getById(id)!.is_active).toBe(1);

    // Correct delegator can revoke
    expect(tracker.revoke(id, 'tg-1')).toBe(true);
    expect(tracker.getById(id)!.is_active).toBe(0);

    // Revoked delegation doesn't appear in active lists
    expect(tracker.getForSentry('sentry-1')).toHaveLength(0);
  });

  it('calculates voting power', () => {
    tracker.create({
      delegatorTgId: 'tg-1',
      sentryAddress: 'sentry-1',
      nftTokenIds: [1],
      totalValue: 10000,
      signature: 'sig1',
      expiresAt: '2099-12-31',
    });
    tracker.create({
      delegatorTgId: 'tg-2',
      sentryAddress: 'sentry-1',
      nftTokenIds: [2, 3],
      totalValue: 25000,
      signature: 'sig2',
      expiresAt: '2099-12-31',
    });

    const power = tracker.getVotingPower('sentry-1');
    expect(power.sentryAddress).toBe('sentry-1');
    expect(power.delegatedValue).toBe(35000); // 10000 + 25000
    expect(power.delegationCount).toBe(2);
    expect(power.totalPower).toBe(35000); // ownValue is 0 until Phase D
  });

  it('getAllVotingPower returns all sentries', () => {
    tracker.create({
      delegatorTgId: 'tg-1',
      sentryAddress: 'sentry-1',
      nftTokenIds: [1],
      totalValue: 10000,
      signature: 'sig1',
      expiresAt: '2099-12-31',
    });
    tracker.create({
      delegatorTgId: 'tg-2',
      sentryAddress: 'sentry-2',
      nftTokenIds: [2],
      totalValue: 20000,
      signature: 'sig2',
      expiresAt: '2099-12-31',
    });

    const all = tracker.getAllVotingPower();
    expect(all).toHaveLength(2);
  });

  it('stats returns correct counts', () => {
    tracker.create({
      delegatorTgId: 'tg-1',
      sentryAddress: 'sentry-1',
      nftTokenIds: [1],
      totalValue: 10000,
      signature: 'sig1',
      expiresAt: '2099-12-31',
    });

    const stats = tracker.stats();
    expect(stats.active).toBe(1);
    expect(stats.totalValue).toBe(10000);
  });

  it('totalDelegatedValue sums active delegations', () => {
    tracker.create({
      delegatorTgId: 'tg-1',
      sentryAddress: 'sentry-1',
      nftTokenIds: [1],
      totalValue: 10000,
      signature: 'sig1',
      expiresAt: '2099-12-31',
    });
    tracker.create({
      delegatorTgId: 'tg-2',
      sentryAddress: 'sentry-2',
      nftTokenIds: [2],
      totalValue: 20000,
      signature: 'sig2',
      expiresAt: '2099-12-31',
    });

    expect(tracker.totalDelegatedValue()).toBe(30000);
  });
});
