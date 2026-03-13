import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../../src/shared/db.js';
import { ProposalManager, PROPOSAL_RULES } from '../../src/sentry/proposals.js';
import type Database from 'better-sqlite3';

describe('ProposalManager', () => {
  let db: Database.Database;
  let proposals: ProposalManager;

  beforeEach(() => {
    db = createDatabase(':memory:');
    proposals = new ProposalManager(db);
  });

  it('creates a proposal with correct defaults', () => {
    const id = proposals.create({
      type: 'code_update',
      proposer: 'sentry-1',
      description: 'Update trading engine v2',
    });

    expect(id).toMatch(/^prop-/);
    const proposal = proposals.getById(id);
    expect(proposal).toBeDefined();
    expect(proposal!.type).toBe('code_update');
    expect(proposal!.proposer).toBe('sentry-1');
    expect(proposal!.status).toBe('active');
    expect(proposal!.threshold_pct).toBe(75); // code_update default
  });

  it('applies correct thresholds per proposal type', () => {
    const codeId = proposals.create({
      type: 'code_update',
      proposer: 's1',
      description: 'code change',
    });
    expect(proposals.getById(codeId)!.threshold_pct).toBe(75);

    const stratId = proposals.create({
      type: 'strategy_change',
      proposer: 's1',
      description: 'switch strategy',
    });
    expect(proposals.getById(stratId)!.threshold_pct).toBe(20);

    const rpcId = proposals.create({
      type: 'rpc_add',
      proposer: 's1',
      description: 'add rpc',
    });
    expect(proposals.getById(rpcId)!.threshold_pct).toBe(50);

    const agentId = proposals.create({
      type: 'agent_registration',
      proposer: 's1',
      description: 'register agent',
    });
    expect(proposals.getById(agentId)!.threshold_pct).toBe(75);
  });

  it('cannot lower threshold below type minimum', () => {
    const id = proposals.create({
      type: 'code_update',
      proposer: 's1',
      description: 'test',
      thresholdPct: 10, // below 75 minimum
    });
    expect(proposals.getById(id)!.threshold_pct).toBe(75); // enforced minimum
  });

  it('can raise threshold above type minimum', () => {
    const id = proposals.create({
      type: 'strategy_change',
      proposer: 's1',
      description: 'test',
      thresholdPct: 50, // above 20 minimum
    });
    expect(proposals.getById(id)!.threshold_pct).toBe(50);
  });

  it('lists active proposals', () => {
    proposals.create({ type: 'code_update', proposer: 's1', description: 'a' });
    proposals.create({ type: 'rpc_add', proposer: 's1', description: 'b' });
    const id3 = proposals.create({ type: 'strategy_change', proposer: 's1', description: 'c' });

    proposals.setStatus(id3, 'passed');

    const active = proposals.listActive();
    expect(active).toHaveLength(2);
  });

  it('lists by type', () => {
    proposals.create({ type: 'code_update', proposer: 's1', description: 'a' });
    proposals.create({ type: 'code_update', proposer: 's1', description: 'b' });
    proposals.create({ type: 'rpc_add', proposer: 's1', description: 'c' });

    expect(proposals.listByType('code_update')).toHaveLength(2);
    expect(proposals.listByType('rpc_add')).toHaveLength(1);
  });

  it('reports stats correctly', () => {
    proposals.create({ type: 'code_update', proposer: 's1', description: 'a' });
    const id2 = proposals.create({ type: 'rpc_add', proposer: 's1', description: 'b' });
    proposals.setStatus(id2, 'failed');

    const stats = proposals.stats();
    expect(stats.active).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.passed).toBe(0);
  });

  it('stores proposal data as JSON', () => {
    const id = proposals.create({
      type: 'strategy_change',
      proposer: 's1',
      description: 'switch',
      data: { action: 'switch_strategy', targetStrategy: 'ema_crossover' },
    });
    const proposal = proposals.getById(id);
    const data = JSON.parse(proposal!.data!);
    expect(data.action).toBe('switch_strategy');
    expect(data.targetStrategy).toBe('ema_crossover');
  });

  it('PROPOSAL_RULES has all 7 types', () => {
    const types = Object.keys(PROPOSAL_RULES);
    expect(types).toHaveLength(7);
    expect(types).toContain('code_update');
    expect(types).toContain('strategy_change');
    expect(types).toContain('agent_registration');
    expect(types).toContain('vault_key_rotation');
  });
});
