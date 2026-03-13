/**
 * NFT Verifier — verify NFT ownership against the fund manager.
 * Used to validate that voters actually hold NFTs and calculate their value.
 */
import type { NFTAccountInfo } from '../shared/types.js';

export interface OwnershipProof {
  tokenId: number;
  ownerTelegramId: string;
  currentBalance: number;  // cents
  isActive: boolean;
  verified: boolean;
  error?: string;
}

export class NFTVerifier {
  private fundManagerEndpoint: string;

  constructor(fundManagerEndpoint: string) {
    this.fundManagerEndpoint = fundManagerEndpoint.replace(/\/$/, '');
  }

  /** Verify ownership of a single NFT. */
  async verifyOwnership(tokenId: number, claimedOwnerTgId: string): Promise<OwnershipProof> {
    try {
      const res = await fetch(`${this.fundManagerEndpoint}/nft/${tokenId}`, {
        signal: AbortSignal.timeout(5_000),
      });

      if (!res.ok) {
        return {
          tokenId,
          ownerTelegramId: claimedOwnerTgId,
          currentBalance: 0,
          isActive: false,
          verified: false,
          error: `HTTP ${res.status}`,
        };
      }

      const info = (await res.json()) as NFTAccountInfo;
      const ownerMatch = info.owner_telegram_id === claimedOwnerTgId;

      return {
        tokenId: info.token_id,
        ownerTelegramId: info.owner_telegram_id,
        currentBalance: info.current_balance,
        isActive: info.is_active === 1,
        verified: ownerMatch && info.is_active === 1,
        error: ownerMatch ? undefined : 'Owner mismatch',
      };
    } catch (err) {
      return {
        tokenId,
        ownerTelegramId: claimedOwnerTgId,
        currentBalance: 0,
        isActive: false,
        verified: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Verify ownership and calculate total value for multiple NFTs. */
  async verifyMultiple(
    tokenIds: number[],
    claimedOwnerTgId: string,
  ): Promise<{ proofs: OwnershipProof[]; totalValue: number; allVerified: boolean }> {
    const proofs: OwnershipProof[] = [];
    let totalValue = 0;

    for (const tokenId of tokenIds) {
      const proof = await this.verifyOwnership(tokenId, claimedOwnerTgId);
      proofs.push(proof);
      if (proof.verified) {
        totalValue += proof.currentBalance;
      }
    }

    return {
      proofs,
      totalValue,
      allVerified: proofs.every((p) => p.verified),
    };
  }

  /** Get the total pool value from the fund manager (for threshold calculations). */
  async getTotalPoolValue(): Promise<number> {
    try {
      const res = await fetch(`${this.fundManagerEndpoint}/status`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const status = (await res.json()) as { total_pool_balance: number };
      return status.total_pool_balance;
    } catch {
      return 0;
    }
  }
}
