/**
 * Voting System — cast votes, tally results, resolve proposals.
 * Voting power is denominated in cents (own NFT value + delegated value).
 */
import type Database from 'better-sqlite3';
import type { Vote, Proposal } from '../shared/types.js';
import type { DelegationTracker } from '../guardian/delegations.js';
import { ProposalManager } from './proposals.js';

export interface TallyResult {
  proposalId: string;
  approveVotes: number;    // count
  rejectVotes: number;     // count
  approvePower: number;    // cents
  rejectPower: number;     // cents
  totalPower: number;      // cents (approve + reject)
  totalPoolValue: number;  // cents (for threshold calculation)
  approvalPct: number;     // percentage of pool value that approved
  thresholdPct: number;    // required percentage
  passed: boolean;
  quorumMet: boolean;      // at least one vote cast
}

export interface CastVoteInput {
  proposalId: string;
  voterAddress: string;
  approve: boolean;
  attestation?: string;
}

export class VotingSystem {
  private db: Database.Database;
  private proposals: ProposalManager;
  private delegations: DelegationTracker;

  constructor(
    db: Database.Database,
    proposals: ProposalManager,
    delegations: DelegationTracker,
  ) {
    this.db = db;
    this.proposals = proposals;
    this.delegations = delegations;
  }

  /**
   * Cast a vote on an active proposal.
   * Voting power = sentry's own NFT value + delegated value.
   */
  castVote(input: CastVoteInput): { voteId: number; votingPower: number } {
    const proposal = this.proposals.getById(input.proposalId);
    if (!proposal) throw new Error(`Proposal not found: ${input.proposalId}`);
    if (proposal.status !== 'active') throw new Error(`Proposal is ${proposal.status}, not active`);

    // Check deadline
    if (new Date(proposal.deadline) <= new Date()) {
      throw new Error('Proposal deadline has passed');
    }

    // Calculate voting power from delegations
    const power = this.delegations.getVotingPower(input.voterAddress);
    if (power.totalPower <= 0) {
      throw new Error('No voting power (no NFTs or delegations)');
    }

    const stmt = this.db.prepare(`
      INSERT INTO votes (proposal_id, voter_address, approve, voting_power, attestation)
      VALUES (?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      input.proposalId,
      input.voterAddress,
      input.approve ? 1 : 0,
      power.totalPower,
      input.attestation ?? null,
    );

    return {
      voteId: result.lastInsertRowid as number,
      votingPower: power.totalPower,
    };
  }

  /** Get all votes for a proposal. */
  getVotes(proposalId: string): Vote[] {
    return this.db
      .prepare('SELECT * FROM votes WHERE proposal_id = ? ORDER BY created_at ASC')
      .all(proposalId) as Vote[];
  }

  /** Check if a voter has already voted on a proposal. */
  hasVoted(proposalId: string, voterAddress: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM votes WHERE proposal_id = ? AND voter_address = ?')
      .get(proposalId, voterAddress);
    return row !== undefined;
  }

  /**
   * Tally votes for a proposal.
   * Threshold is measured as percentage of total pool value (not just voters).
   */
  tally(proposalId: string, totalPoolValue: number): TallyResult {
    const proposal = this.proposals.getById(proposalId);
    if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);

    const votes = this.getVotes(proposalId);

    let approvePower = 0;
    let rejectPower = 0;
    let approveVotes = 0;
    let rejectVotes = 0;

    for (const vote of votes) {
      if (vote.approve) {
        approvePower += vote.voting_power;
        approveVotes++;
      } else {
        rejectPower += vote.voting_power;
        rejectVotes++;
      }
    }

    const totalPower = approvePower + rejectPower;
    // Approval is % of total pool value (not just participating votes)
    const approvalPct = totalPoolValue > 0 ? (approvePower / totalPoolValue) * 100 : 0;
    const quorumMet = votes.length > 0;
    const passed = quorumMet && approvalPct >= proposal.threshold_pct;

    return {
      proposalId,
      approveVotes,
      rejectVotes,
      approvePower,
      rejectPower,
      totalPower,
      totalPoolValue,
      approvalPct,
      thresholdPct: proposal.threshold_pct,
      passed,
      quorumMet,
    };
  }

  /**
   * Resolve a proposal: tally votes and update status to passed/failed.
   * Called manually or by background job after deadline.
   */
  resolve(proposalId: string, totalPoolValue: number): TallyResult {
    const result = this.tally(proposalId, totalPoolValue);
    const newStatus = result.passed ? 'passed' : 'failed';
    this.proposals.setStatus(proposalId, newStatus);
    return result;
  }

  /**
   * Resolve all active proposals that have passed their deadline.
   * Returns resolved proposals with their tally results.
   */
  resolveExpired(totalPoolValue: number): TallyResult[] {
    const active = this.proposals.listActive();
    const now = new Date();
    const results: TallyResult[] = [];

    for (const proposal of active) {
      if (new Date(proposal.deadline) <= now) {
        results.push(this.resolve(proposal.id, totalPoolValue));
      }
    }

    return results;
  }

  /** Get voting stats for a specific voter across all proposals. */
  getVoterHistory(voterAddress: string): Vote[] {
    return this.db
      .prepare('SELECT * FROM votes WHERE voter_address = ? ORDER BY created_at DESC')
      .all(voterAddress) as Vote[];
  }
}
