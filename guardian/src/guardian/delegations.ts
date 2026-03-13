/**
 * Delegation Tracker — record delegations, verify NFT ownership, calculate voting power.
 * NFT holders delegate their voting power to sentry nodes (guardians with is_sentry=1).
 */
import type Database from 'better-sqlite3';
import type { Delegation, NFTAccountInfo } from '../shared/types.js';

export interface VotingPower {
  sentryAddress: string;
  ownValue: number;          // cents — sentry's own NFT value
  delegatedValue: number;    // cents — delegated to this sentry
  totalPower: number;        // cents — own + delegated
  delegationCount: number;
}

export class DelegationTracker {
  private db: Database.Database;
  private fundManagerEndpoint: string;
  private getOwnValue?: (sentryAddress: string) => number;

  constructor(
    db: Database.Database,
    fundManagerEndpoint: string,
    opts?: { getOwnValue?: (sentryAddress: string) => number },
  ) {
    this.db = db;
    this.fundManagerEndpoint = fundManagerEndpoint.replace(/\/$/, '');
    this.getOwnValue = opts?.getOwnValue;
  }

  /** Record a new delegation. */
  create(delegation: {
    delegatorTgId: string;
    sentryAddress: string;
    nftTokenIds: number[];
    totalValue: number;
    signature: string;
    expiresAt: string;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO delegations (delegator_tg_id, sentry_address, nft_token_ids, total_value, signature, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      delegation.delegatorTgId,
      delegation.sentryAddress,
      JSON.stringify(delegation.nftTokenIds),
      delegation.totalValue,
      delegation.signature,
      delegation.expiresAt,
    );
    return result.lastInsertRowid as number;
  }

  /** Get a delegation by ID. */
  getById(id: number): Delegation | undefined {
    return this.db
      .prepare('SELECT * FROM delegations WHERE id = ?')
      .get(id) as Delegation | undefined;
  }

  /** Get all active delegations for a sentry. */
  getForSentry(sentryAddress: string): Delegation[] {
    return this.db
      .prepare(
        "SELECT * FROM delegations WHERE sentry_address = ? AND is_active = 1 AND expires_at > datetime('now') ORDER BY created_at DESC",
      )
      .all(sentryAddress) as Delegation[];
  }

  /** Get all active delegations from a delegator. */
  getByDelegator(delegatorTgId: string): Delegation[] {
    return this.db
      .prepare(
        "SELECT * FROM delegations WHERE delegator_tg_id = ? AND is_active = 1 AND expires_at > datetime('now') ORDER BY created_at DESC",
      )
      .all(delegatorTgId) as Delegation[];
  }

  /** Revoke a delegation. Only the delegator can revoke. */
  revoke(id: number, delegatorTgId: string): boolean {
    const result = this.db
      .prepare('UPDATE delegations SET is_active = 0 WHERE id = ? AND delegator_tg_id = ?')
      .run(id, delegatorTgId);
    return result.changes > 0;
  }

  /** Expire all delegations past their deadline. Returns count expired. */
  expireOld(): number {
    const result = this.db
      .prepare("UPDATE delegations SET is_active = 0 WHERE is_active = 1 AND expires_at <= datetime('now')")
      .run();
    return result.changes;
  }

  /**
   * Update delegation values by fetching current NFT balances from fund manager.
   * Called hourly as balances change with trading P&L.
   */
  async updateValues(): Promise<number> {
    const activeDelegations = this.db
      .prepare("SELECT * FROM delegations WHERE is_active = 1 AND expires_at > datetime('now')")
      .all() as Delegation[];

    let updated = 0;

    for (const delegation of activeDelegations) {
      const tokenIds: number[] = JSON.parse(delegation.nft_token_ids);
      let totalValue = 0;

      for (const tokenId of tokenIds) {
        try {
          const res = await fetch(`${this.fundManagerEndpoint}/nft/${tokenId}`, {
            signal: AbortSignal.timeout(5_000),
          });
          if (res.ok) {
            const info = (await res.json()) as NFTAccountInfo;
            if (info.is_active) {
              totalValue += info.current_balance;
            }
          }
        } catch {
          // Skip unreachable — keep old value
        }
      }

      if (totalValue !== delegation.total_value) {
        this.db
          .prepare('UPDATE delegations SET total_value = ? WHERE id = ?')
          .run(totalValue, delegation.id);
        updated++;
      }
    }

    return updated;
  }

  /**
   * Calculate voting power for a sentry node.
   * Power = sentry's own NFT value + all delegated NFT values (in cents).
   */
  getVotingPower(sentryAddress: string): VotingPower {
    const delegations = this.getForSentry(sentryAddress);
    const delegatedValue = delegations.reduce((sum, d) => sum + d.total_value, 0);

    const ownValue = this.getOwnValue?.(sentryAddress) ?? 0;

    return {
      sentryAddress,
      ownValue,
      delegatedValue,
      totalPower: ownValue + delegatedValue,
      delegationCount: delegations.length,
    };
  }

  /** Get voting power for all sentries with active delegations or staked NFTs. */
  getAllVotingPower(): VotingPower[] {
    const sentries = this.db
      .prepare(`
        SELECT DISTINCT sentry_address FROM delegations
        WHERE is_active = 1 AND expires_at > datetime('now')
        UNION
        SELECT DISTINCT guardian_address AS sentry_address FROM nft_stakes
        WHERE is_active = 1
      `)
      .all() as { sentry_address: string }[];

    return sentries.map((s) => this.getVotingPower(s.sentry_address));
  }

  /** Get total delegated value across all delegations (cents). */
  totalDelegatedValue(): number {
    const row = this.db
      .prepare(`
        SELECT COALESCE(SUM(total_value), 0) as total FROM delegations
        WHERE is_active = 1 AND expires_at > datetime('now')
      `)
      .get() as { total: number };
    return row.total;
  }

  /** Stats summary. */
  stats(): { active: number; expired: number; totalValue: number } {
    const active = (
      this.db
        .prepare("SELECT COUNT(*) as c FROM delegations WHERE is_active = 1 AND expires_at > datetime('now')")
        .get() as { c: number }
    ).c;
    const expired = (
      this.db
        .prepare("SELECT COUNT(*) as c FROM delegations WHERE is_active = 0 OR expires_at <= datetime('now')")
        .get() as { c: number }
    ).c;
    return { active, expired, totalValue: this.totalDelegatedValue() };
  }
}
