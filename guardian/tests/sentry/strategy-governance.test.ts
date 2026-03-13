import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../../src/shared/db.js';
import { ProposalManager } from '../../src/sentry/proposals.js';
import { VotingSystem } from '../../src/sentry/voting.js';
import { DelegationTracker } from '../../src/guardian/delegations.js';
import { StrategyGovernance } from '../../src/sentry/strategy-governance.js';
import type Database from 'better-sqlite3';

describe('StrategyGovernance', () => {
  let db: Database.Database;
  let proposals: ProposalManager;
  let voting: VotingSystem;
  let delegations: DelegationTracker;
  let strategyGov: StrategyGovernance;

  beforeEach(() => {
    db = createDatabase(':memory:');
    proposals = new ProposalManager(db);
    delegations = new DelegationTracker(db, 'http://localhost:3000');
    voting = new VotingSystem(db, proposals, delegations);
    strategyGov = new StrategyGovernance(db, proposals, voting, 'http://localhost:3000');

    // Set up sentry with voting power
    delegations.create({
      delegatorTgId: 'holder-1',
      sentryAddress: 'sentry-1',
      nftTokenIds: [1, 2],
      totalValue: 60000,
      signature: 'sig1',
      expiresAt: '2099-12-31',
    });
  });

  it('creates a strategy switch proposal with correct threshold', () => {
    const id = strategyGov.proposeStrategySwitch({
      proposer: 'sentry-1',
      currentStrategy: 'dca_accumulator',
      targetStrategy: 'ema_crossover',
      reason: 'Better performance in trending market',
    });

    const proposal = proposals.getById(id);
    expect(proposal).toBeDefined();
    expect(proposal!.type).toBe('strategy_change');
    expect(proposal!.threshold_pct).toBe(20); // strategy_change default
    expect(proposal!.description).toContain('dca_accumulator');
    expect(proposal!.description).toContain('ema_crossover');

    const data = JSON.parse(proposal!.data!);
    expect(data.action).toBe('switch_strategy');
    expect(data.targetStrategy).toBe('ema_crossover');
  });

  it('creates a parameter adjustment proposal with lower threshold', () => {
    const id = strategyGov.proposeParameterAdjust({
      proposer: 'sentry-1',
      strategy: 'rsi_mean_reversion',
      parameters: { rsiPeriod: 21, oversold: 25, overbought: 75 },
      reason: 'Reduce false signals',
    });

    const proposal = proposals.getById(id);
    expect(proposal).toBeDefined();
    expect(proposal!.threshold_pct).toBe(20); // 15% is below strategy_change min of 20%, so 20% is enforced
    // Actually: param adjust uses thresholdPct: 15 but the type is strategy_change with min 20%
    // ProposalManager enforces max(15, 20) = 20

    const data = JSON.parse(proposal!.data!);
    expect(data.action).toBe('adjust_parameters');
    expect(data.parameters.rsiPeriod).toBe(21);
  });

  it('strategy switch passes with 20% approval', () => {
    const proposalId = strategyGov.proposeStrategySwitch({
      proposer: 'sentry-1',
      currentStrategy: 'dca',
      targetStrategy: 'ema',
      reason: 'test',
    });

    // sentry-1 approves (60000 cents)
    voting.castVote({ proposalId, voterAddress: 'sentry-1', approve: true });

    // Total pool = 100000 cents, approval = 60% >= 20%
    const tally = voting.tally(proposalId, 100000);
    expect(tally.passed).toBe(true);
    expect(tally.approvalPct).toBe(60);
  });

  it('strategy switch fails with insufficient approval', () => {
    // Add a small sentry
    delegations.create({
      delegatorTgId: 'holder-2',
      sentryAddress: 'sentry-2',
      nftTokenIds: [3],
      totalValue: 5000, // only 5%
      signature: 'sig2',
      expiresAt: '2099-12-31',
    });

    const proposalId = strategyGov.proposeStrategySwitch({
      proposer: 'sentry-2',
      currentStrategy: 'dca',
      targetStrategy: 'ema',
      reason: 'test',
    });

    // Only small sentry approves (5000/100000 = 5%)
    voting.castVote({ proposalId, voterAddress: 'sentry-2', approve: true });

    const tally = voting.tally(proposalId, 100000);
    expect(tally.passed).toBe(false);
    expect(tally.approvalPct).toBe(5); // 5% < 20%
  });

  it('lists strategy proposals', () => {
    strategyGov.proposeStrategySwitch({
      proposer: 's1',
      currentStrategy: 'a',
      targetStrategy: 'b',
      reason: 'r',
    });
    strategyGov.proposeParameterAdjust({
      proposer: 's1',
      strategy: 'c',
      parameters: { x: 1 },
      reason: 'r',
    });

    // Also create a non-strategy proposal
    proposals.create({ type: 'rpc_add', proposer: 's1', description: 'unrelated' });

    const stratProposals = strategyGov.listStrategyProposals();
    expect(stratProposals).toHaveLength(2);
    expect(stratProposals.every((p) => p.type === 'strategy_change')).toBe(true);
  });

  it('executeChange rejects non-passed proposals', async () => {
    const id = strategyGov.proposeStrategySwitch({
      proposer: 's1',
      currentStrategy: 'a',
      targetStrategy: 'b',
      reason: 'r',
    });

    const result = await strategyGov.executeChange(id);
    expect(result.success).toBe(false);
    expect(result.error).toContain('active');
  });
});
