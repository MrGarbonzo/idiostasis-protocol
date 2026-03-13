/**
 * Strategy Governance — vote to switch strategies or adjust parameters.
 *
 * Strategy change:   20% threshold, 24h deadline
 * Parameter adjust:  15% threshold, 12h deadline
 *
 * After a proposal passes, sends the change to the fund manager for hot-reload.
 */
import type Database from 'better-sqlite3';
import { ProposalManager, PROPOSAL_RULES } from './proposals.js';
import { VotingSystem } from './voting.js';

/** Strategy change proposal data stored in proposals.data JSON. */
export interface StrategyChangeData {
  action: 'switch_strategy' | 'adjust_parameters';
  currentStrategy?: string;
  targetStrategy?: string;
  parameters?: Record<string, unknown>;
}

/** Parameter adjustment rules. */
const PARAM_ADJUST_THRESHOLD_PCT = 15;
const PARAM_ADJUST_DEADLINE_HOURS = 12;

export class StrategyGovernance {
  private db: Database.Database;
  private proposals: ProposalManager;
  private voting: VotingSystem;
  private fundManagerEndpoint: string;

  constructor(
    db: Database.Database,
    proposals: ProposalManager,
    voting: VotingSystem,
    fundManagerEndpoint: string,
  ) {
    this.db = db;
    this.proposals = proposals;
    this.voting = voting;
    this.fundManagerEndpoint = fundManagerEndpoint.replace(/\/$/, '');
  }

  /**
   * Propose switching to a different strategy.
   * Threshold: 20%, Deadline: 24h (from PROPOSAL_RULES.strategy_change).
   */
  proposeStrategySwitch(input: {
    proposer: string;
    currentStrategy: string;
    targetStrategy: string;
    reason: string;
  }): string {
    const data: StrategyChangeData = {
      action: 'switch_strategy',
      currentStrategy: input.currentStrategy,
      targetStrategy: input.targetStrategy,
    };

    return this.proposals.create({
      type: 'strategy_change',
      proposer: input.proposer,
      description: `Switch strategy from ${input.currentStrategy} to ${input.targetStrategy}: ${input.reason}`,
      data: data as unknown as Record<string, unknown>,
      thresholdPct: PROPOSAL_RULES.strategy_change.thresholdPct,
      deadlineHours: PROPOSAL_RULES.strategy_change.deadlineHours,
    });
  }

  /**
   * Propose adjusting strategy parameters.
   * Lower threshold (15%) and shorter deadline (12h) than a full switch.
   */
  proposeParameterAdjust(input: {
    proposer: string;
    strategy: string;
    parameters: Record<string, unknown>;
    reason: string;
  }): string {
    const data: StrategyChangeData = {
      action: 'adjust_parameters',
      targetStrategy: input.strategy,
      parameters: input.parameters,
    };

    return this.proposals.create({
      type: 'strategy_change',
      proposer: input.proposer,
      description: `Adjust ${input.strategy} parameters: ${input.reason}`,
      data: data as unknown as Record<string, unknown>,
      thresholdPct: PARAM_ADJUST_THRESHOLD_PCT,
      deadlineHours: PARAM_ADJUST_DEADLINE_HOURS,
    });
  }

  /**
   * Execute a passed strategy change by notifying the fund manager.
   * Called after a proposal is resolved as 'passed'.
   */
  async executeChange(proposalId: string): Promise<{ success: boolean; error?: string }> {
    const proposal = this.proposals.getById(proposalId);
    if (!proposal) return { success: false, error: 'Proposal not found' };
    if (proposal.status !== 'passed') return { success: false, error: `Proposal is ${proposal.status}` };
    if (!proposal.data) return { success: false, error: 'No strategy data in proposal' };

    const data = JSON.parse(proposal.data) as StrategyChangeData;

    try {
      if (data.action === 'switch_strategy' && data.targetStrategy) {
        const res = await fetch(`${this.fundManagerEndpoint}/strategy/switch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ strategy: data.targetStrategy }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { success: true };
      }

      if (data.action === 'adjust_parameters' && data.targetStrategy && data.parameters) {
        const res = await fetch(`${this.fundManagerEndpoint}/strategy/params`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            strategy: data.targetStrategy,
            parameters: data.parameters,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { success: true };
      }

      return { success: false, error: 'Unknown action or missing data' };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** List all strategy-related proposals. */
  listStrategyProposals(): import('../shared/types.js').Proposal[] {
    return this.proposals.listByType('strategy_change');
  }

  /**
   * Get the current active strategy from the fund manager.
   */
  async getCurrentStrategy(): Promise<{ strategy: string; parameters?: Record<string, unknown> } | null> {
    try {
      const res = await fetch(`${this.fundManagerEndpoint}/strategy`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return null;
      return (await res.json()) as { strategy: string; parameters?: Record<string, unknown> };
    } catch {
      return null;
    }
  }
}
