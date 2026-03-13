/**
 * EVM Discovery Client — read-only agent/guardian discovery via ERC-8004 registry on Base.
 *
 * Guardians use this to discover the active agent endpoint from the on-chain
 * registry. No wallet or gas needed — all operations are view calls.
 */
import { createPublicClient, http, type PublicClient, type Chain, type Transport } from 'viem';
import { baseSepolia } from 'viem/chains';

// ── ABI (subset: read-only methods) ─────────────────────────────

const registryAbi = [
  {
    type: 'function' as const,
    name: 'getActiveByType' as const,
    inputs: [{ name: 'entityType', type: 'uint8' as const }],
    outputs: [{ name: 'tokenIds', type: 'uint256[]' as const }],
    stateMutability: 'view' as const,
  },
  {
    type: 'function' as const,
    name: 'getEntry' as const,
    inputs: [{ name: 'tokenId', type: 'uint256' as const }],
    outputs: [
      { name: 'entityType', type: 'uint8' as const },
      { name: 'endpoint', type: 'string' as const },
      { name: 'teeInstanceId', type: 'bytes16' as const },
      { name: 'codeHash', type: 'bytes32' as const },
      { name: 'attestationHash', type: 'bytes32' as const },
      { name: 'ed25519Pubkey', type: 'bytes32' as const },
      { name: 'registeredAt', type: 'uint256' as const },
      { name: 'lastHeartbeat', type: 'uint256' as const },
      { name: 'isActive', type: 'bool' as const },
      { name: 'owner', type: 'address' as const },
    ],
    stateMutability: 'view' as const,
  },
] as const;

// ── Types ────────────────────────────────────────────────────────

export interface DiscoveryEntry {
  entityType: 'agent' | 'guardian';
  endpoint: string;
  teeInstanceId: string;
  codeHash: string;
  attestationHash: string;
  ed25519Pubkey: string;
  registeredAt: number;
  lastHeartbeat: number;
  isActive: boolean;
  owner: string;
}

// ── Helpers ──────────────────────────────────────────────────────

function hexFromBytes(bytes: string): string {
  return bytes.replace(/^0x/, '').replace(/0+$/, '') || '';
}

function base64FromBytes32(hex: string): string {
  const clean = hex.replace(/^0x/, '');
  return Buffer.from(clean, 'hex').toString('base64');
}

// ── Client ───────────────────────────────────────────────────────

export class EvmDiscoveryClient {
  private client: PublicClient<Transport, Chain>;
  private contractAddress: `0x${string}`;

  constructor(
    rpcUrl: string,
    contractAddress: `0x${string}`,
    chain: Chain = baseSepolia,
  ) {
    this.contractAddress = contractAddress;
    this.client = createPublicClient({
      chain,
      transport: http(rpcUrl),
    }) as PublicClient<Transport, Chain>;
  }

  /** Get all active agent entries. */
  async getAgents(): Promise<DiscoveryEntry[]> {
    return this.getEntriesByType(0);
  }

  /** Get all active guardian entries. */
  async getGuardians(): Promise<DiscoveryEntry[]> {
    return this.getEntriesByType(1);
  }

  private async getEntriesByType(entityType: number): Promise<DiscoveryEntry[]> {
    try {
      const tokenIds = await this.client.readContract({
        address: this.contractAddress,
        abi: registryAbi,
        functionName: 'getActiveByType',
        args: [entityType],
      });

      const entries: DiscoveryEntry[] = [];
      for (const tokenId of tokenIds) {
        const entry = await this.getEntryByTokenId(tokenId);
        if (entry) entries.push(entry);
      }
      return entries;
    } catch (err) {
      console.error(`[EvmDiscovery] Failed to fetch entries (type=${entityType}):`, err);
      return [];
    }
  }

  private async getEntryByTokenId(tokenId: bigint): Promise<DiscoveryEntry | null> {
    try {
      const result = await this.client.readContract({
        address: this.contractAddress,
        abi: registryAbi,
        functionName: 'getEntry',
        args: [tokenId],
      });

      const [
        entityType, endpoint, teeInstanceId, codeHash,
        attestationHash, ed25519Pubkey, registeredAt,
        lastHeartbeat, isActive, owner,
      ] = result;

      return {
        entityType: entityType === 0 ? 'agent' : 'guardian',
        endpoint,
        teeInstanceId: hexFromBytes(teeInstanceId),
        codeHash: hexFromBytes(codeHash),
        attestationHash: hexFromBytes(attestationHash),
        ed25519Pubkey: base64FromBytes32(ed25519Pubkey),
        registeredAt: Number(registeredAt),
        lastHeartbeat: Number(lastHeartbeat),
        isActive,
        owner,
      };
    } catch {
      return null;
    }
  }
}
