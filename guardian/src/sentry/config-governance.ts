/**
 * Config Governance — generalized governance for all config change types.
 *
 * Replaces StrategyGovernance as the main governance module.
 * Handles: RPC changes, strategy changes, trading limits,
 * emergency pause/unpause, TEE measurements, code updates.
 *
 * Flow: Guardian proposes → Sentries vote → Approved change pushed to agent via HTTP.
 */
import type Database from 'better-sqlite3';
import { ProposalManager, PROPOSAL_RULES } from './proposals.js';
import { VotingSystem } from './voting.js';
import type { ProposalType, Proposal } from '../shared/types.js';

/** Maps proposal types to agent config API endpoints. */
const CONFIG_ENDPOINTS: Partial<Record<ProposalType, string>> = {
  rpc_add:             '/api/config/rpc',
  rpc_remove:          '/api/config/rpc',
  strategy_change:     '/api/config/strategy',
  trading_limits:      '/api/config/trading-limits',
  emergency_pause:     '/api/config/pause',
  emergency_unpause:   '/api/config/pause',
  tee_measurement:     '/api/config/tee-measurements',
  code_update:         '/api/config/code-update',
};

/** Proposal types that ConfigGovernance can execute (push to agent). */
export const EXECUTABLE_CONFIG_TYPES = new Set(Object.keys(CONFIG_ENDPOINTS));

export class ConfigGovernance {
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

  /** Update the fund manager endpoint (e.g. after re-discovery). */
  updateEndpoint(endpoint: string): void {
    this.fundManagerEndpoint = endpoint.replace(/\/$/, '');
  }

  // ── Generic propose ────────────────────────────────────────

  /**
   * Create a proposal for any config change type.
   */
  propose(input: {
    type: ProposalType;
    proposer: string;
    description: string;
    configData: Record<string, unknown>;
    fundId?: string;
  }): string {
    return this.proposals.create({
      type: input.type,
      proposer: input.proposer,
      description: input.description,
      data: input.configData,
      fundId: input.fundId,
    });
  }

  // ── Convenience methods ────────────────────────────────────

  proposeRpcChange(input: {
    proposer: string;
    action: 'add' | 'remove';
    chain: string;
    url: string;
    reason: string;
    fundId?: string;
  }): string {
    const type: ProposalType = input.action === 'add' ? 'rpc_add' : 'rpc_remove';
    return this.propose({
      type,
      proposer: input.proposer,
      description: `${input.action === 'add' ? 'Add' : 'Remove'} RPC endpoint for ${input.chain}: ${input.reason}`,
      configData: { action: input.action, chain: input.chain, url: input.url },
      fundId: input.fundId,
    });
  }

  proposeStrategyChange(input: {
    proposer: string;
    targetStrategy: string;
    parameters?: Record<string, unknown>;
    reason: string;
    fundId?: string;
  }): string {
    return this.propose({
      type: 'strategy_change',
      proposer: input.proposer,
      description: `Switch strategy to ${input.targetStrategy}: ${input.reason}`,
      configData: {
        action: 'switch',
        strategy: input.targetStrategy,
        parameters: input.parameters ?? {},
      },
      fundId: input.fundId,
    });
  }

  proposeTradingLimits(input: {
    proposer: string;
    limits: Record<string, number>;
    reason: string;
    fundId?: string;
  }): string {
    return this.propose({
      type: 'trading_limits',
      proposer: input.proposer,
      description: `Update trading limits: ${input.reason}`,
      configData: { action: 'update', ...input.limits },
      fundId: input.fundId,
    });
  }

  proposeEmergencyAction(input: {
    proposer: string;
    action: 'pause' | 'unpause';
    reason: string;
    fundId?: string;
  }): string {
    const type: ProposalType = input.action === 'pause' ? 'emergency_pause' : 'emergency_unpause';
    return this.propose({
      type,
      proposer: input.proposer,
      description: `Emergency ${input.action}: ${input.reason}`,
      configData: { action: input.action },
      fundId: input.fundId,
    });
  }

  proposeTEEMeasurement(input: {
    proposer: string;
    action: 'approve' | 'revoke';
    measurement: string;
    reason: string;
    fundId?: string;
  }): string {
    return this.propose({
      type: 'tee_measurement',
      proposer: input.proposer,
      description: `${input.action === 'approve' ? 'Approve' : 'Revoke'} TEE measurement: ${input.reason}`,
      configData: { action: input.action, measurement: input.measurement },
      fundId: input.fundId,
    });
  }

  // ── Execute approved change ────────────────────────────────

  /**
   * After a proposal passes, push the config change to the agent via HTTP.
   */
  async executeChange(proposalId: string): Promise<{ success: boolean; error?: string }> {
    const proposal = this.proposals.getById(proposalId);
    if (!proposal) return { success: false, error: 'Proposal not found' };
    if (proposal.status !== 'passed') return { success: false, error: `Proposal is ${proposal.status}` };
    if (!proposal.data) return { success: false, error: 'No config data in proposal' };

    const endpoint = CONFIG_ENDPOINTS[proposal.type];
    if (!endpoint) {
      return { success: false, error: `No agent endpoint for proposal type: ${proposal.type}` };
    }

    const configData = JSON.parse(proposal.data) as Record<string, unknown>;
    const action = String(configData.action ?? proposal.type);

    const body = {
      proposalId,
      type: proposal.type,
      action,
      payload: configData,
    };

    try {
      const res = await fetch(`${this.fundManagerEndpoint}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const text = await res.text();
        return { success: false, error: `Agent responded ${res.status}: ${text}` };
      }

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── Queries ────────────────────────────────────────────────

  listConfigProposals(type?: ProposalType): Proposal[] {
    if (type) return this.proposals.listByType(type);
    // Return all config-related proposals (everything except agent_registration)
    const active = this.proposals.listActive();
    return active;
  }
}
