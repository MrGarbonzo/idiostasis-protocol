/**
 * NFT Staking Manager — guardians stake fund NFTs to earn sentry status.
 * Uses NFTVerifier for ownership checks against the fund manager.
 */
import type Database from 'better-sqlite3';
import type { NFTVerifier } from '../sentry/nft-verifier.js';
import type { NFTAccountInfo } from '../shared/types.js';

export interface NFTStake {
  id: number;
  guardian_address: string;
  owner_tg_id: string;
  token_id: number;
  current_value: number;
  is_active: number;
  last_verified: string;
  created_at: string;
  staked_at: string;
  unstaked_at: string | null;
}

/** 7-day restake cooldown in milliseconds. */
const RESTAKE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export class NFTStakingManager {
  private db: Database.Database;
  private nftVerifier: NFTVerifier;
  private fundManagerEndpoint: string;

  constructor(db: Database.Database, nftVerifier: NFTVerifier, fundManagerEndpoint: string) {
    this.db = db;
    this.nftVerifier = nftVerifier;
    this.fundManagerEndpoint = fundManagerEndpoint.replace(/\/$/, '');
    this.migrateStakingColumns();
  }

  /** Add staked_at and unstaked_at columns to existing DBs. */
  private migrateStakingColumns(): void {
    const cols = this.db.pragma('table_info(nft_stakes)') as Array<{ name: string }>;
    const names = new Set(cols.map(c => c.name));
    if (!names.has('staked_at')) {
      this.db.exec(`ALTER TABLE nft_stakes ADD COLUMN staked_at TEXT NOT NULL DEFAULT (datetime('now'))`);
    }
    if (!names.has('unstaked_at')) {
      this.db.exec(`ALTER TABLE nft_stakes ADD COLUMN unstaked_at TEXT`);
    }
  }

  /** Stake specific NFTs for a guardian. Verifies ownership of each. */
  async stakeNFTs(
    guardianAddress: string,
    ownerTgId: string,
    tokenIds: number[],
  ): Promise<{ staked: number[]; failed: Array<{ tokenId: number; error: string }> }> {
    const staked: number[] = [];
    const failed: Array<{ tokenId: number; error: string }> = [];

    for (const tokenId of tokenIds) {
      // Check restake cooldown before verifying ownership
      const cooldown = this.checkRestakeCooldown(guardianAddress, tokenId);
      if (!cooldown.allowed) {
        failed.push({ tokenId, error: `Restake cooldown active — unlocks at ${cooldown.unlocksAt}` });
        continue;
      }

      const proof = await this.nftVerifier.verifyOwnership(tokenId, ownerTgId);
      if (!proof.verified) {
        failed.push({ tokenId, error: proof.error ?? 'Verification failed' });
        continue;
      }

      this.db.prepare(`
        INSERT INTO nft_stakes (guardian_address, owner_tg_id, token_id, current_value, is_active, last_verified, staked_at, unstaked_at)
        VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'), NULL)
        ON CONFLICT(guardian_address, token_id) DO UPDATE SET
          owner_tg_id = excluded.owner_tg_id,
          current_value = excluded.current_value,
          is_active = 1,
          last_verified = datetime('now'),
          staked_at = datetime('now'),
          unstaked_at = NULL
      `).run(guardianAddress, ownerTgId, tokenId, proof.currentBalance);

      staked.push(tokenId);
    }

    return { staked, failed };
  }

  /** Stake all NFTs owned by the given Telegram user. */
  async stakeAll(
    guardianAddress: string,
    ownerTgId: string,
  ): Promise<{ staked: number[]; failed: Array<{ tokenId: number; error: string }> }> {
    // Fetch all NFTs owned by this user from fund manager
    const tokenIds = await this.fetchOwnerTokenIds(ownerTgId);
    if (tokenIds.length === 0) {
      return { staked: [], failed: [] };
    }
    return this.stakeNFTs(guardianAddress, ownerTgId, tokenIds);
  }

  /** Deactivate all stakes for a guardian. */
  unstakeAll(guardianAddress: string): number {
    const result = this.db.prepare(
      `UPDATE nft_stakes SET is_active = 0, unstaked_at = datetime('now') WHERE guardian_address = ? AND is_active = 1`
    ).run(guardianAddress);
    return result.changes;
  }

  /** Deactivate all stakes for a specific owner on a guardian. */
  unstakeByOwner(guardianAddress: string, ownerTgId: string): number {
    const result = this.db.prepare(
      `UPDATE nft_stakes SET is_active = 0, unstaked_at = datetime('now') WHERE guardian_address = ? AND owner_tg_id = ? AND is_active = 1`
    ).run(guardianAddress, ownerTgId);
    return result.changes;
  }

  /** Get all active stakes for a given owner. */
  getStakesByOwner(ownerTgId: string): NFTStake[] {
    return this.db.prepare(
      `SELECT * FROM nft_stakes WHERE owner_tg_id = ? AND is_active = 1 ORDER BY token_id`
    ).all(ownerTgId) as NFTStake[];
  }

  /** Get all active stakes for a guardian. */
  getActiveStakes(guardianAddress: string): NFTStake[] {
    return this.db.prepare(
      `SELECT * FROM nft_stakes WHERE guardian_address = ? AND is_active = 1 ORDER BY token_id`
    ).all(guardianAddress) as NFTStake[];
  }

  /** Get total staked value for a guardian (cents). */
  getTotalStakedValue(guardianAddress: string): number {
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(current_value), 0) as total FROM nft_stakes WHERE guardian_address = ? AND is_active = 1`
    ).get(guardianAddress) as { total: number };
    return row.total;
  }

  /** Check if a guardian has any active stakes. */
  hasActiveStakes(guardianAddress: string): boolean {
    const row = this.db.prepare(
      `SELECT COUNT(*) as c FROM nft_stakes WHERE guardian_address = ? AND is_active = 1`
    ).get(guardianAddress) as { c: number };
    return row.c > 0;
  }

  /**
   * Re-verify all active stakes. Revokes stakes where ownership is lost,
   * updates values for valid stakes. Called hourly.
   */
  async reverify(): Promise<{ updated: number; revoked: number }> {
    const activeStakes = this.db.prepare(
      `SELECT * FROM nft_stakes WHERE is_active = 1`
    ).all() as NFTStake[];

    let updated = 0;
    let revoked = 0;

    for (const stake of activeStakes) {
      const proof = await this.nftVerifier.verifyOwnership(stake.token_id, stake.owner_tg_id);

      if (!proof.verified) {
        // Ownership lost — revoke
        this.db.prepare(
          `UPDATE nft_stakes SET is_active = 0, unstaked_at = datetime('now'), last_verified = datetime('now') WHERE id = ?`
        ).run(stake.id);
        revoked++;
        console.log(`[NFTStaking] Revoked stake: token #${stake.token_id} for ${stake.guardian_address} (${proof.error ?? 'ownership lost'})`);
      } else if (proof.currentBalance !== stake.current_value) {
        // Value changed — update
        this.db.prepare(
          `UPDATE nft_stakes SET current_value = ?, last_verified = datetime('now') WHERE id = ?`
        ).run(proof.currentBalance, stake.id);
        updated++;
      } else {
        // No change — just touch last_verified
        this.db.prepare(
          `UPDATE nft_stakes SET last_verified = datetime('now') WHERE id = ?`
        ).run(stake.id);
      }
    }

    return { updated, revoked };
  }

  /**
   * Check if a token is within the 7-day restake cooldown.
   * Looks at the most recent inactive row for this (guardian, token) pair.
   */
  checkRestakeCooldown(guardianAddress: string, tokenId: number): { allowed: boolean; unlocksAt?: string } {
    const row = this.db.prepare(
      `SELECT unstaked_at FROM nft_stakes
       WHERE guardian_address = ? AND token_id = ? AND is_active = 0 AND unstaked_at IS NOT NULL
       ORDER BY unstaked_at DESC LIMIT 1`
    ).get(guardianAddress, tokenId) as { unstaked_at: string } | undefined;

    if (!row) return { allowed: true };

    const unstakedMs = new Date(row.unstaked_at + 'Z').getTime();
    const unlocksMs = unstakedMs + RESTAKE_COOLDOWN_MS;
    if (Date.now() < unlocksMs) {
      return { allowed: false, unlocksAt: new Date(unlocksMs).toISOString() };
    }
    return { allowed: true };
  }

  /**
   * Check if a guardian has a vote lock (active proposals with votes in the last 48h).
   * Returns true if locked (should not unstake).
   */
  checkVoteLock(guardianAddress: string): boolean {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS c FROM votes v
       JOIN proposals p ON v.proposal_id = p.id
       WHERE v.voter_address = ? AND p.status = 'active'
         AND v.created_at >= datetime('now', '-48 hours')`
    ).get(guardianAddress) as { c: number };
    return row.c > 0;
  }

  /** Fetch token IDs owned by a Telegram user from the fund manager. */
  private async fetchOwnerTokenIds(ownerTgId: string): Promise<number[]> {
    try {
      const res = await fetch(`${this.fundManagerEndpoint}/nfts/owner/${ownerTgId}`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return [];
      const accounts = (await res.json()) as NFTAccountInfo[];
      return accounts.filter(a => a.is_active === 1).map(a => a.token_id);
    } catch {
      return [];
    }
  }
}
