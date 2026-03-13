/**
 * Proposal Manager — create, query, and manage governance proposals.
 * Each proposal type has its own threshold and deadline rules.
 */
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Proposal, ProposalType, ProposalStatus } from '../shared/types.js';

/** Default thresholds and deadlines per proposal type. All thresholds 75% of pool value. */
export const PROPOSAL_RULES: Record<
  ProposalType,
  { thresholdPct: number; deadlineHours: number }
> = {
  code_update:         { thresholdPct: 75, deadlineHours: 48 },
  rpc_add:             { thresholdPct: 75, deadlineHours: 24 },
  rpc_remove:          { thresholdPct: 75, deadlineHours: 24 },
  strategy_change:     { thresholdPct: 75, deadlineHours: 24 },
  anomaly_resolution:  { thresholdPct: 75, deadlineHours: 12 },
  agent_registration:  { thresholdPct: 75, deadlineHours: 1 },
  vault_key_rotation:  { thresholdPct: 75, deadlineHours: 4 },
  trading_limits:      { thresholdPct: 75, deadlineHours: 24 },
  emergency_pause:     { thresholdPct: 75, deadlineHours: 4 },
  emergency_unpause:   { thresholdPct: 75, deadlineHours: 4 },
  tee_measurement:     { thresholdPct: 75, deadlineHours: 24 },
};

export interface CreateProposalInput {
  type: ProposalType;
  proposer: string;
  description: string;
  data?: Record<string, unknown>;
  /** Override default threshold (must be ≥ type minimum). */
  thresholdPct?: number;
  /** Override default deadline hours. */
  deadlineHours?: number;
  /** Scope proposal to a specific fund (null = global). */
  fundId?: string;
}

export class ProposalManager {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Create a new proposal. Returns the proposal ID. */
  create(input: CreateProposalInput): string {
    const rules = PROPOSAL_RULES[input.type];
    const thresholdPct = Math.max(input.thresholdPct ?? rules.thresholdPct, rules.thresholdPct);
    const deadlineHours = input.deadlineHours ?? rules.deadlineHours;

    const id = `prop-${randomBytes(8).toString('hex')}`;
    const deadline = new Date(Date.now() + deadlineHours * 60 * 60 * 1000).toISOString();

    this.db
      .prepare(`
        INSERT INTO proposals (id, type, proposer, description, data, fund_id, threshold_pct, deadline)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.type,
        input.proposer,
        input.description,
        input.data ? JSON.stringify(input.data) : null,
        input.fundId ?? null,
        thresholdPct,
        deadline,
      );

    return id;
  }

  /** Get a proposal by ID. */
  getById(id: string): Proposal | undefined {
    return this.db
      .prepare('SELECT * FROM proposals WHERE id = ?')
      .get(id) as Proposal | undefined;
  }

  /** List proposals by status. */
  listByStatus(status: ProposalStatus): Proposal[] {
    return this.db
      .prepare('SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC')
      .all(status) as Proposal[];
  }

  /** List active proposals. */
  listActive(): Proposal[] {
    return this.listByStatus('active');
  }

  /** List proposals by type. */
  listByType(type: ProposalType): Proposal[] {
    return this.db
      .prepare('SELECT * FROM proposals WHERE type = ? ORDER BY created_at DESC')
      .all(type) as Proposal[];
  }

  /** Update proposal status. */
  setStatus(id: string, status: ProposalStatus): boolean {
    const result = this.db
      .prepare('UPDATE proposals SET status = ? WHERE id = ?')
      .run(status, id);
    return result.changes > 0;
  }

  /** Expire proposals past their deadline. Returns count expired. */
  expireOverdue(): number {
    const result = this.db
      .prepare(`
        UPDATE proposals SET status = 'expired'
        WHERE status = 'active' AND deadline <= datetime('now')
      `)
      .run();
    return result.changes;
  }

  /** Get proposals summary stats. */
  stats(): Record<ProposalStatus, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) as cnt FROM proposals GROUP BY status')
      .all() as { status: ProposalStatus; cnt: number }[];

    const counts: Record<ProposalStatus, number> = { active: 0, passed: 0, failed: 0, expired: 0 };
    for (const row of rows) {
      counts[row.status] = row.cnt;
    }
    return counts;
  }
}
