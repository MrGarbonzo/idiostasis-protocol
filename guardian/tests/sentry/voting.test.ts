import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../../src/shared/db.js';
import { ProposalManager } from '../../src/sentry/proposals.js';
import { VotingSystem } from '../../src/sentry/voting.js';
import { DelegationTracker } from '../../src/guardian/delegations.js';
import type Database from 'better-sqlite3';

describe('VotingSystem', () => {
  let db: Database.Database;
  let proposals: ProposalManager;
  let delegations: DelegationTracker;
  let voting: VotingSystem;

  beforeEach(() => {
    db = createDatabase(':memory:');
    proposals = new ProposalManager(db);
    delegations = new DelegationTracker(db, 'http://localhost:3000');
    voting = new VotingSystem(db, proposals, delegations);

    // Set up delegations so sentries have voting power
    delegations.create({
      delegatorTgId: 'holder-1',
      sentryAddress: 'sentry-1',
      nftTokenIds: [1, 2],
      totalValue: 50000, // $500
      signature: 'sig1',
      expiresAt: '2099-12-31',
    });
    delegations.create({
      delegatorTgId: 'holder-2',
      sentryAddress: 'sentry-2',
      nftTokenIds: [3],
      totalValue: 30000, // $300
      signature: 'sig2',
      expiresAt: '2099-12-31',
    });
    delegations.create({
      delegatorTgId: 'holder-3',
      sentryAddress: 'sentry-3',
      nftTokenIds: [4, 5, 6],
      totalValue: 20000, // $200
      signature: 'sig3',
      expiresAt: '2099-12-31',
    });
  });

  it('casts a vote with correct voting power', () => {
    const proposalId = proposals.create({
      type: 'strategy_change',
      proposer: 'sentry-1',
      description: 'switch to ema',
    });

    const result = voting.castVote({
      proposalId,
      voterAddress: 'sentry-1',
      approve: true,
    });

    expect(result.votingPower).toBe(50000);
    expect(result.voteId).toBeGreaterThan(0);
  });

  it('prevents double voting', () => {
    const proposalId = proposals.create({
      type: 'rpc_add',
      proposer: 'sentry-1',
      description: 'add rpc',
    });

    voting.castVote({ proposalId, voterAddress: 'sentry-1', approve: true });
    expect(() =>
      voting.castVote({ proposalId, voterAddress: 'sentry-1', approve: false }),
    ).toThrow(); // UNIQUE constraint
  });

  it('rejects vote on non-existent proposal', () => {
    expect(() =>
      voting.castVote({ proposalId: 'fake', voterAddress: 'sentry-1', approve: true }),
    ).toThrow('not found');
  });

  it('rejects vote from address with no voting power', () => {
    const proposalId = proposals.create({
      type: 'rpc_add',
      proposer: 'sentry-1',
      description: 'add rpc',
    });

    expect(() =>
      voting.castVote({ proposalId, voterAddress: 'nobody', approve: true }),
    ).toThrow('No voting power');
  });

  it('tallies votes correctly against total pool value', () => {
    const proposalId = proposals.create({
      type: 'strategy_change', // 20% threshold
      proposer: 'sentry-1',
      description: 'switch strategy',
    });

    // sentry-1 approves (50000 cents)
    voting.castVote({ proposalId, voterAddress: 'sentry-1', approve: true });
    // sentry-2 rejects (30000 cents)
    voting.castVote({ proposalId, voterAddress: 'sentry-2', approve: false });

    // Total pool = 100000 cents ($1000)
    const tally = voting.tally(proposalId, 100000);

    expect(tally.approveVotes).toBe(1);
    expect(tally.rejectVotes).toBe(1);
    expect(tally.approvePower).toBe(50000);
    expect(tally.rejectPower).toBe(30000);
    expect(tally.approvalPct).toBe(50); // 50000/100000 = 50%
    expect(tally.thresholdPct).toBe(20); // strategy_change threshold
    expect(tally.passed).toBe(true); // 50% >= 20%
  });

  it('proposal fails when approval below threshold', () => {
    const proposalId = proposals.create({
      type: 'code_update', // 75% threshold
      proposer: 'sentry-1',
      description: 'code change',
    });

    // Only sentry-3 approves (20000 cents out of 100000 = 20%)
    voting.castVote({ proposalId, voterAddress: 'sentry-3', approve: true });

    const tally = voting.tally(proposalId, 100000);
    expect(tally.approvalPct).toBe(20);
    expect(tally.passed).toBe(false); // 20% < 75%
  });

  it('proposal passes with overwhelming approval', () => {
    const proposalId = proposals.create({
      type: 'code_update', // 75% threshold
      proposer: 'sentry-1',
      description: 'code change',
    });

    // All three approve: 50000 + 30000 + 20000 = 100000 / 100000 = 100%
    voting.castVote({ proposalId, voterAddress: 'sentry-1', approve: true });
    voting.castVote({ proposalId, voterAddress: 'sentry-2', approve: true });
    voting.castVote({ proposalId, voterAddress: 'sentry-3', approve: true });

    const tally = voting.tally(proposalId, 100000);
    expect(tally.approvalPct).toBe(100);
    expect(tally.passed).toBe(true);
  });

  it('resolve updates proposal status', () => {
    const proposalId = proposals.create({
      type: 'strategy_change',
      proposer: 'sentry-1',
      description: 'test',
    });

    voting.castVote({ proposalId, voterAddress: 'sentry-1', approve: true });

    const result = voting.resolve(proposalId, 100000);
    expect(result.passed).toBe(true);
    expect(proposals.getById(proposalId)!.status).toBe('passed');
  });

  it('resolve marks failed proposal', () => {
    const proposalId = proposals.create({
      type: 'code_update', // 75% threshold
      proposer: 'sentry-1',
      description: 'test',
    });

    voting.castVote({ proposalId, voterAddress: 'sentry-3', approve: true }); // only 20%

    const result = voting.resolve(proposalId, 100000);
    expect(result.passed).toBe(false);
    expect(proposals.getById(proposalId)!.status).toBe('failed');
  });

  it('hasVoted returns correct status', () => {
    const proposalId = proposals.create({
      type: 'rpc_add',
      proposer: 'sentry-1',
      description: 'test',
    });

    expect(voting.hasVoted(proposalId, 'sentry-1')).toBe(false);
    voting.castVote({ proposalId, voterAddress: 'sentry-1', approve: true });
    expect(voting.hasVoted(proposalId, 'sentry-1')).toBe(true);
  });

  it('getVotes returns all votes for a proposal', () => {
    const proposalId = proposals.create({
      type: 'rpc_add',
      proposer: 'sentry-1',
      description: 'test',
    });

    voting.castVote({ proposalId, voterAddress: 'sentry-1', approve: true });
    voting.castVote({ proposalId, voterAddress: 'sentry-2', approve: false });

    const votes = voting.getVotes(proposalId);
    expect(votes).toHaveLength(2);
  });

  it('getVoterHistory returns voter activity', () => {
    const p1 = proposals.create({ type: 'rpc_add', proposer: 's1', description: 'a' });
    const p2 = proposals.create({ type: 'rpc_remove', proposer: 's1', description: 'b' });

    voting.castVote({ proposalId: p1, voterAddress: 'sentry-1', approve: true });
    voting.castVote({ proposalId: p2, voterAddress: 'sentry-1', approve: false });

    const history = voting.getVoterHistory('sentry-1');
    expect(history).toHaveLength(2);
  });
});
