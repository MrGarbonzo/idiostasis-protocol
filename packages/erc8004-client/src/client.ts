import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Chain,
} from 'viem';
import { baseSepolia, base } from 'viem/chains';
import type {
  AgentRegistration,
  ServiceRecord,
  RegistrationParams,
  EvmWallet,
} from './types.js';

// ERC-8004 Identity Registry ABI — matches deployed contract on Base.
// Read by 8004scan.io — https://www.8004scan.io
const IDENTITY_REGISTRY_ABI = [
  {
    type: 'function' as const,
    name: 'register' as const,
    inputs: [{ name: 'agentURI', type: 'string' as const }],
    outputs: [{ name: 'agentId', type: 'uint256' as const }],
    stateMutability: 'nonpayable' as const,
  },
  {
    type: 'function' as const,
    name: 'tokenURI' as const,
    inputs: [{ name: 'tokenId', type: 'uint256' as const }],
    outputs: [{ name: '', type: 'string' as const }],
    stateMutability: 'view' as const,
  },
  {
    type: 'function' as const,
    name: 'ownerOf' as const,
    inputs: [{ name: 'tokenId', type: 'uint256' as const }],
    outputs: [{ name: '', type: 'address' as const }],
    stateMutability: 'view' as const,
  },
  {
    type: 'function' as const,
    name: 'setAgentURI' as const,
    inputs: [
      { name: 'agentId', type: 'uint256' as const },
      { name: 'newURI', type: 'string' as const },
    ],
    outputs: [],
    stateMutability: 'nonpayable' as const,
  },
] as const;

// ERC-721 Transfer event topic: keccak256("Transfer(address,address,uint256)")
const TRANSFER_EVENT_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Official ERC-8004 Identity Registry — erc-8004/erc-8004-contracts
// Read by 8004scan.io — https://www.8004scan.io
export const ERC8004_REGISTRY_ADDRESS_BASE_SEPOLIA = '0x8004A818BFB912233c491871b3d84c89A494BD9e';

// Base mainnet — saved for Phase 13 (mainnet deployment)
export const ERC8004_REGISTRY_ADDRESS_BASE_MAINNET = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

const CHAINS: Record<string, Chain> = {
  'base-sepolia': baseSepolia,
  'base': base,
};

interface AgentMetadata {
  type: string;
  name: string;
  description: string;
  image: string;
  services: ServiceRecord[];
  x402Support: boolean;
  active: boolean;
  supportedTrust: string[];
}

/**
 * Client for interacting with the ERC-8004 Identity Registry on Base.
 * Uses viem for all contract interactions.
 * Metadata is stored as data URIs in tokenURI (ERC-721 + URIStorage pattern).
 *
 * TODO: migrate to IPFS/Arweave for production metadata storage.
 */
export class ERC8004Client {
  protected readonly registryAddress: `0x${string}`;
  protected readonly chainConfig: Chain;
  protected readonly rpcUrl: string;
  private readonly publicClient: ReturnType<typeof createPublicClient>;

  constructor(
    baseRpcUrl: string,
    registryAddress: string,
    chain: 'base-sepolia' | 'base' = 'base-sepolia',
  ) {
    this.rpcUrl = baseRpcUrl;
    this.registryAddress = registryAddress as `0x${string}`;
    this.chainConfig = CHAINS[chain] ?? baseSepolia;
    this.publicClient = createPublicClient({
      chain: this.chainConfig,
      transport: http(baseRpcUrl || undefined),
    });
  }

  async register(params: RegistrationParams): Promise<{ tokenId: number; txHash: string }> {
    const { name, description, services, wallet, image } = params;
    const metadata = buildMetadata(name, description, services, image);
    const dataUri = encodeMetadataToDataUri(metadata);

    const txHash = await this.contractWrite('register', [dataUri], wallet);
    const receipt = await this.txReceipt(txHash);
    const tokenId = parseTokenIdFromReceipt(receipt);

    return { tokenId, txHash };
  }

  async updateEndpoint(
    tokenId: number,
    serviceName: string,
    newEndpoint: string,
    wallet: EvmWallet,
  ): Promise<string> {
    const currentUri = await this.contractRead('tokenURI', [BigInt(tokenId)]) as string;
    const metadata = decodeDataUri(currentUri);
    if (!metadata) throw new Error(`Cannot decode metadata for token ${tokenId}`);

    const existing = metadata.services.find(s => s.name === serviceName);
    if (existing) {
      existing.endpoint = newEndpoint;
    } else {
      metadata.services.push({ name: serviceName, endpoint: newEndpoint });
    }

    const newUri = encodeMetadataToDataUri(metadata);
    const txHash = await this.contractWrite('setAgentURI', [BigInt(tokenId), newUri], wallet);
    await this.txReceipt(txHash);
    return txHash;
  }

  async getRegistration(tokenId: number): Promise<AgentRegistration | null> {
    try {
      const uri = await this.contractRead('tokenURI', [BigInt(tokenId)]) as string;
      if (!uri) return null;
      const metadata = decodeDataUri(uri);
      if (!metadata) return null;

      const owner = await this.contractRead('ownerOf', [BigInt(tokenId)]) as string;
      return {
        tokenId,
        owner,
        name: metadata.name,
        description: metadata.description,
        services: metadata.services,
        active: metadata.active,
        registeredAt: 0,
        updatedAt: 0,
      };
    } catch {
      return null;
    }
  }

  async updateAllEndpoints(
    tokenId: number,
    services: { name: string; endpoint: string }[],
    wallet: EvmWallet,
  ): Promise<string> {
    const currentUri = await this.contractRead('tokenURI', [BigInt(tokenId)]) as string;
    const metadata = decodeDataUri(currentUri);
    if (!metadata) throw new Error(`Cannot decode metadata for token ${tokenId}`);

    for (const { name, endpoint } of services) {
      const existing = metadata.services.find(s => s.name === name);
      if (existing) {
        existing.endpoint = endpoint;
      } else {
        metadata.services.push({ name, endpoint });
      }
    }

    const newUri = encodeMetadataToDataUri(metadata);
    const txHash = await this.contractWrite('setAgentURI', [BigInt(tokenId), newUri], wallet);
    await this.txReceipt(txHash);
    return txHash;
  }

  async findByRtmr3(_rtmr3: string): Promise<AgentRegistration[]> {
    // TODO: use event indexing — contract does not expose totalSupply
    console.warn('[erc8004] findByRtmr3 not implemented — requires event indexing');
    return [];
  }

  async getLivePrimaryAddress(tokenId: number): Promise<string | null> {
    const reg = await this.getRegistration(tokenId);
    if (!reg || !reg.active) return null;
    const discoveryService = reg.services.find(s => s.name === 'discovery');
    return discoveryService?.endpoint ?? null;
  }

  async isActive(tokenId: number): Promise<boolean> {
    const reg = await this.getRegistration(tokenId);
    return reg?.active ?? false;
  }

  // --- Protected methods for testability ---

  protected async contractRead(functionName: string, args: readonly unknown[]): Promise<unknown> {
    return this.publicClient.readContract({
      address: this.registryAddress,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: functionName as any,
      args: args as any,
    });
  }

  protected async contractWrite(
    functionName: string,
    args: readonly unknown[],
    wallet: EvmWallet,
  ): Promise<`0x${string}`> {
    const client = createWalletClient({
      account: wallet.account as Account,
      chain: this.chainConfig,
      transport: http(this.rpcUrl || undefined),
    });
    return client.writeContract({
      address: this.registryAddress,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: functionName as any,
      args: args as any,
    });
  }

  protected async txReceipt(
    hash: `0x${string}`,
  ): Promise<{ logs: readonly { topics: readonly string[]; data: string }[] }> {
    return this.publicClient.waitForTransactionReceipt({ hash }) as any;
  }
}

// --- Metadata helpers ---

function buildMetadata(name: string, description: string, services: ServiceRecord[], image?: string): AgentMetadata {
  return {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name,
    description,
    image: image ?? '',
    services,
    x402Support: true,
    active: true,
    supportedTrust: ['tee-attestation'],
  };
}

export function encodeMetadataToDataUri(metadata: AgentMetadata): string {
  const json = JSON.stringify(metadata);
  const base64 = Buffer.from(json).toString('base64');
  return `data:application/json;base64,${base64}`;
}

export function decodeDataUri(dataUri: string): AgentMetadata | null {
  const prefix = 'data:application/json;base64,';
  if (!dataUri.startsWith(prefix)) return null;
  try {
    const base64 = dataUri.slice(prefix.length);
    const json = Buffer.from(base64, 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function parseTokenIdFromReceipt(
  receipt: { logs: readonly { topics: readonly string[]; data: string }[] },
): number {
  for (const log of receipt.logs) {
    if (log.topics[0] === TRANSFER_EVENT_TOPIC && log.topics.length >= 4) {
      return Number(BigInt(log.topics[3]));
    }
  }
  throw new Error('No Transfer event found in transaction receipt');
}
