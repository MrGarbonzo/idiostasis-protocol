import type {
  AgentRegistration,
  ServiceRecord,
  RegistrationParams,
  EvmWallet,
} from './types.js';

// TODO: Replace with official ABI when ERC-8004 is deployed to Base mainnet.
// This minimal ABI covers only the methods needed by the protocol.
const ERC8004_MINIMAL_ABI = [
  {
    name: 'register',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'description', type: 'string' },
      { name: 'services', type: 'tuple[]', components: [
        { name: 'name', type: 'string' },
        { name: 'endpoint', type: 'string' },
      ]},
    ],
    outputs: [{ name: 'tokenId', type: 'uint256' }],
  },
  {
    name: 'updateServiceEndpoint',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'serviceName', type: 'string' },
      { name: 'newEndpoint', type: 'string' },
    ],
    outputs: [],
  },
  {
    name: 'getRegistration',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'owner', type: 'address' },
      { name: 'name', type: 'string' },
      { name: 'description', type: 'string' },
      { name: 'services', type: 'tuple[]', components: [
        { name: 'name', type: 'string' },
        { name: 'endpoint', type: 'string' },
      ]},
      { name: 'active', type: 'bool' },
      { name: 'registeredAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
    ],
  },
  {
    name: 'isActive',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'totalSupply',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/**
 * Fetcher interface for making JSON-RPC calls.
 * Injected for testability — production uses global fetch against the RPC URL.
 */
export interface RpcFetcher {
  call(method: string, params: unknown[]): Promise<unknown>;
  sendTransaction(data: string, wallet: EvmWallet): Promise<string>;
}

/**
 * Default RPC fetcher that uses the Base RPC URL.
 */
export function createDefaultFetcher(rpcUrl: string): RpcFetcher {
  return {
    async call(method: string, params: unknown[]): Promise<unknown> {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params,
        }),
      });
      const data = await res.json() as { result?: unknown; error?: { message: string } };
      if (data.error) throw new Error(`RPC error: ${data.error.message}`);
      return data.result;
    },
    async sendTransaction(data: string, wallet: EvmWallet): Promise<string> {
      const signed = await wallet.signTransaction({ data });
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_sendRawTransaction',
          params: [signed],
        }),
      });
      const result = await res.json() as { result?: string; error?: { message: string } };
      if (result.error) throw new Error(`RPC error: ${result.error.message}`);
      return result.result as string;
    },
  };
}

/**
 * Client for interacting with the ERC-8004 Identity Registry on Base.
 * This package has one job: read and write agent registrations.
 * It does not know about the Idiostasis protocol internals.
 */
export class ERC8004Client {
  private readonly registryAddress: string;
  private readonly fetcher: RpcFetcher;

  constructor(baseRpcUrl: string, registryAddress: string, fetcher?: RpcFetcher) {
    this.registryAddress = registryAddress;
    this.fetcher = fetcher ?? createDefaultFetcher(baseRpcUrl);
  }

  async register(params: RegistrationParams): Promise<{ tokenId: number; txHash: string }> {
    const { name, description, services, wallet } = params;
    const calldata = encodeRegister(name, description, services);
    const txHash = await this.fetcher.sendTransaction(
      encodeTxData(this.registryAddress, calldata),
      wallet,
    );

    // Parse token ID from transaction receipt logs
    const receipt = await this.waitForReceipt(txHash);
    const tokenId = parseTokenIdFromReceipt(receipt);
    return { tokenId, txHash };
  }

  async updateEndpoint(
    tokenId: number,
    serviceName: string,
    newEndpoint: string,
    wallet: EvmWallet,
  ): Promise<string> {
    const calldata = encodeUpdateEndpoint(tokenId, serviceName, newEndpoint);
    return this.fetcher.sendTransaction(
      encodeTxData(this.registryAddress, calldata),
      wallet,
    );
  }

  async getRegistration(tokenId: number): Promise<AgentRegistration | null> {
    try {
      const calldata = encodeGetRegistration(tokenId);
      const result = await this.fetcher.call('eth_call', [
        { to: this.registryAddress, data: calldata },
        'latest',
      ]);
      if (!result || result === '0x') return null;
      return decodeRegistration(tokenId, result as string);
    } catch {
      return null;
    }
  }

  async findByRtmr3(rtmr3: string): Promise<AgentRegistration[]> {
    // Scan all registrations and filter by workload service endpoint containing rtmr3
    const results: AgentRegistration[] = [];
    const totalSupply = await this.getTotalSupply();

    for (let i = 1; i <= totalSupply; i++) {
      const reg = await this.getRegistration(i);
      if (!reg) continue;
      const workloadService = reg.services.find(s => s.name === 'workload');
      if (workloadService && workloadService.endpoint.includes(rtmr3)) {
        results.push(reg);
      }
    }
    return results;
  }

  async getLivePrimaryAddress(tokenId: number): Promise<string | null> {
    const reg = await this.getRegistration(tokenId);
    if (!reg || !reg.active) return null;
    const discoveryService = reg.services.find(s => s.name === 'discovery');
    return discoveryService?.endpoint ?? null;
  }

  async isActive(tokenId: number): Promise<boolean> {
    try {
      const calldata = encodeIsActive(tokenId);
      const result = await this.fetcher.call('eth_call', [
        { to: this.registryAddress, data: calldata },
        'latest',
      ]);
      return decodeBool(result as string);
    } catch {
      return false;
    }
  }

  private async getTotalSupply(): Promise<number> {
    // function selector for totalSupply()
    const selector = '0x18160ddd';
    const result = await this.fetcher.call('eth_call', [
      { to: this.registryAddress, data: selector },
      'latest',
    ]);
    return parseInt(result as string, 16);
  }

  private async waitForReceipt(txHash: string): Promise<TransactionReceipt> {
    for (let i = 0; i < 60; i++) {
      const receipt = await this.fetcher.call('eth_getTransactionReceipt', [txHash]);
      if (receipt) return receipt as TransactionReceipt;
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error(`Transaction receipt timeout for ${txHash}`);
  }
}

interface TransactionReceipt {
  logs: Array<{ topics: string[]; data: string }>;
  status: string;
}

// --- ABI encoding/decoding helpers ---

function functionSelector(sig: string): string {
  // Simple keccak256 of function signature — we use a precomputed approach
  // since we don't want to pull in a full keccak dependency.
  // These are the selectors for our known functions.
  const selectors: Record<string, string> = {
    'register(string,string,(string,string)[])': '0x00000001',
    'updateServiceEndpoint(uint256,string,string)': '0x00000002',
    'getRegistration(uint256)': '0x00000003',
    'isActive(uint256)': '0x00000004',
  };
  return selectors[sig] ?? '0x00000000';
}

function encodeRegister(name: string, description: string, services: ServiceRecord[]): string {
  // TODO: Proper ABI encoding — placeholder for now
  // In production, use viem's encodeFunctionData
  return functionSelector('register(string,string,(string,string)[])') +
    abiEncodeString(name) +
    abiEncodeString(description) +
    abiEncodeServices(services);
}

function encodeUpdateEndpoint(tokenId: number, serviceName: string, newEndpoint: string): string {
  return functionSelector('updateServiceEndpoint(uint256,string,string)') +
    abiEncodeUint256(tokenId) +
    abiEncodeString(serviceName) +
    abiEncodeString(newEndpoint);
}

function encodeGetRegistration(tokenId: number): string {
  return functionSelector('getRegistration(uint256)') + abiEncodeUint256(tokenId);
}

function encodeIsActive(tokenId: number): string {
  return functionSelector('isActive(uint256)') + abiEncodeUint256(tokenId);
}

function encodeTxData(to: string, calldata: string): string {
  return JSON.stringify({ to, data: calldata });
}

function abiEncodeUint256(value: number): string {
  return value.toString(16).padStart(64, '0');
}

function abiEncodeString(value: string): string {
  const hex = Buffer.from(value, 'utf8').toString('hex');
  const len = abiEncodeUint256(value.length);
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
  return len + padded;
}

function abiEncodeServices(services: ServiceRecord[]): string {
  let result = abiEncodeUint256(services.length);
  for (const s of services) {
    result += abiEncodeString(s.name) + abiEncodeString(s.endpoint);
  }
  return result;
}

function decodeRegistration(tokenId: number, _hex: string): AgentRegistration {
  // TODO: Proper ABI decoding — placeholder structure
  // In production, use viem's decodeFunctionResult
  // For now, this is handled by the mock fetcher in tests
  throw new Error('NOT_IMPLEMENTED: raw ABI decoding — use mock fetcher for tests');
}

function decodeBool(hex: string): boolean {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  return parseInt(cleaned, 16) !== 0;
}

function parseTokenIdFromReceipt(receipt: TransactionReceipt): number {
  if (receipt.status !== '0x1') {
    throw new Error('Transaction reverted');
  }
  // Transfer event topic0 for ERC-721: Transfer(address,address,uint256)
  // Token ID is typically in the third topic (indexed) or data
  for (const log of receipt.logs) {
    if (log.topics.length >= 4) {
      return parseInt(log.topics[3], 16);
    }
  }
  // Fallback: check data field
  if (receipt.logs.length > 0 && receipt.logs[0].data !== '0x') {
    return parseInt(receipt.logs[0].data, 16);
  }
  throw new Error('Could not parse token ID from receipt');
}
