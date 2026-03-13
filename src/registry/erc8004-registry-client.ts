/**
 * ERC8004RegistryClient — on-chain discovery registry for agent/guardian discovery.
 *
 * Reads/writes to an ERC-8004 contract on Base L2 that stores endpoint + TEE
 * identity for each registered node. Replaces the previous Solana-based registry
 * with identical operations: register, heartbeat, discover, update endpoint, deactivate.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Chain,
  type Transport,
  type Address,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import type { LocalAccount } from 'viem/accounts';

// ── ABI (inlined from contracts/IdiostasisRegistry.abi.json) ──────────

const registryAbi = [
  {
    type: 'function' as const,
    name: 'register' as const,
    inputs: [
      { name: 'entityType', type: 'uint8' as const },
      { name: 'endpoint', type: 'string' as const },
      { name: 'teeInstanceId', type: 'bytes16' as const },
      { name: 'codeHash', type: 'bytes32' as const },
      { name: 'attestationHash', type: 'bytes32' as const },
      { name: 'ed25519Pubkey', type: 'bytes32' as const },
    ],
    outputs: [{ name: 'tokenId', type: 'uint256' as const }],
    stateMutability: 'nonpayable' as const,
  },
  {
    type: 'function' as const,
    name: 'heartbeat' as const,
    inputs: [{ name: 'tokenId', type: 'uint256' as const }],
    outputs: [],
    stateMutability: 'nonpayable' as const,
  },
  {
    type: 'function' as const,
    name: 'updateEndpoint' as const,
    inputs: [
      { name: 'tokenId', type: 'uint256' as const },
      { name: 'newEndpoint', type: 'string' as const },
    ],
    outputs: [],
    stateMutability: 'nonpayable' as const,
  },
  {
    type: 'function' as const,
    name: 'deactivate' as const,
    inputs: [{ name: 'tokenId', type: 'uint256' as const }],
    outputs: [],
    stateMutability: 'nonpayable' as const,
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
  {
    type: 'function' as const,
    name: 'getTokenByOwner' as const,
    inputs: [{ name: 'owner', type: 'address' as const }],
    outputs: [{ name: 'tokenId', type: 'uint256' as const }],
    stateMutability: 'view' as const,
  },
  {
    type: 'function' as const,
    name: 'getActiveByType' as const,
    inputs: [{ name: 'entityType', type: 'uint8' as const }],
    outputs: [{ name: 'tokenIds', type: 'uint256[]' as const }],
    stateMutability: 'view' as const,
  },
] as const;

// ── Types ─────────────────────────────────────────────────────────

/** Decoded registry entry with string-encoded fields. */
export interface RegistryEntry {
  entityType: 'agent' | 'guardian';
  endpoint: string;
  teeInstanceId: string;
  codeHash: string;
  attestationHash: string;
  ed25519Pubkey: string;
  registeredAt: number;
  lastHeartbeat: number;
  isActive: boolean;
  /** 0x EVM address of the entry owner. */
  owner: string;
}

/** Input for registerSelf — omits fields set automatically. */
export interface RegisterSelfInput {
  entityType: 'agent' | 'guardian';
  endpoint: string;
  teeInstanceId: string;
  codeHash: string;
  attestationHash: string;
  ed25519Pubkey: string;
  isActive: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────

function hexFromBytes(bytes: string): string {
  // bytes16/bytes32 from contract come as 0x-prefixed hex
  return bytes.replace(/^0x/, '').replace(/0+$/, '') || '';
}

function base64FromBytes32(hex: string): string {
  const clean = hex.replace(/^0x/, '');
  return Buffer.from(clean, 'hex').toString('base64');
}

function toBytes16(hex: string): `0x${string}` {
  const clean = hex.replace(/^0x/, '');
  return `0x${clean.padEnd(32, '0')}` as `0x${string}`;
}

function toBytes32Hex(hex: string): `0x${string}` {
  const clean = hex.replace(/^0x/, '');
  return `0x${clean.padEnd(64, '0')}` as `0x${string}`;
}

function toBytes32Base64(b64: string): `0x${string}` {
  const buf = Buffer.alloc(32);
  if (b64) Buffer.from(b64, 'base64').copy(buf);
  return `0x${buf.toString('hex')}` as `0x${string}`;
}

// ── Client ────────────────────────────────────────────────────────

export class ERC8004RegistryClient {
  private publicClient: PublicClient<Transport, Chain>;
  private walletClient: WalletClient<Transport, Chain, LocalAccount>;
  private contractAddress: Address;
  private account: LocalAccount;

  constructor(
    rpcUrl: string,
    account: LocalAccount,
    contractAddress: `0x${string}`,
    chain: Chain = baseSepolia,
  ) {
    this.account = account;
    this.contractAddress = contractAddress;

    this.publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    }) as PublicClient<Transport, Chain>;

    this.walletClient = createWalletClient({
      account,
      chain,
      transport: http(rpcUrl),
    }) as WalletClient<Transport, Chain, LocalAccount>;
  }

  // ── Read Operations ─────────────────────────────────────────

  /** Get all guardian entries from the registry. */
  async getGuardians(): Promise<RegistryEntry[]> {
    return this.getEntriesByType(1);
  }

  /** Get all agent entries from the registry. */
  async getAgents(): Promise<RegistryEntry[]> {
    return this.getEntriesByType(0);
  }

  // ── Write Operations ────────────────────────────────────────

  /** Register this node in the on-chain registry. Returns tx hash. */
  async registerSelf(input: RegisterSelfInput): Promise<string> {
    const entityType = input.entityType === 'agent' ? 0 : 1;

    const hash = await this.walletClient.writeContract({
      address: this.contractAddress,
      abi: registryAbi,
      functionName: 'register',
      args: [
        entityType,
        input.endpoint,
        toBytes16(input.teeInstanceId),
        toBytes32Hex(input.codeHash),
        toBytes32Hex(input.attestationHash),
        toBytes32Base64(input.ed25519Pubkey),
      ],
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  /** Send on-chain heartbeat to update lastHeartbeat timestamp. */
  async sendHeartbeat(): Promise<string> {
    const tokenId = await this.getOwnTokenId();

    const hash = await this.walletClient.writeContract({
      address: this.contractAddress,
      abi: registryAbi,
      functionName: 'heartbeat',
      args: [tokenId],
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  /** Update this node's endpoint in the on-chain registry. */
  async updateEndpoint(newEndpoint: string): Promise<string> {
    const tokenId = await this.getOwnTokenId();

    const hash = await this.walletClient.writeContract({
      address: this.contractAddress,
      abi: registryAbi,
      functionName: 'updateEndpoint',
      args: [tokenId, newEndpoint],
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  /** Deactivate this node's entry in the registry. */
  async deactivate(): Promise<string> {
    const tokenId = await this.getOwnTokenId();

    const hash = await this.walletClient.writeContract({
      address: this.contractAddress,
      abi: registryAbi,
      functionName: 'deactivate',
      args: [tokenId],
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  // ── Private ───────────────────────────────────────────────────

  private async getOwnTokenId(): Promise<bigint> {
    const tokenId = await this.publicClient.readContract({
      address: this.contractAddress,
      abi: registryAbi,
      functionName: 'getTokenByOwner',
      args: [this.account.address],
    });
    return tokenId;
  }

  private async getEntriesByType(entityType: number): Promise<RegistryEntry[]> {
    try {
      const tokenIds = await this.publicClient.readContract({
        address: this.contractAddress,
        abi: registryAbi,
        functionName: 'getActiveByType',
        args: [entityType],
      });

      const entries: RegistryEntry[] = [];
      for (const tokenId of tokenIds) {
        const entry = await this.getEntryByTokenId(tokenId);
        if (entry) entries.push(entry);
      }
      return entries;
    } catch (err) {
      console.error(`[ERC8004Registry] Failed to fetch entries (type=${entityType}):`, err);
      return [];
    }
  }

  private async getEntryByTokenId(tokenId: bigint): Promise<RegistryEntry | null> {
    try {
      const result = await this.publicClient.readContract({
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
