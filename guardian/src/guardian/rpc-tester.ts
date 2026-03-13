/**
 * RPC Tester — probe RPC endpoints for connectivity, correctness, latency.
 * Auto-deprecates RPCs with reputation below threshold.
 */
import { RpcRegistry } from './rpc-registry.js';
import type { RpcEntry } from '../shared/types.js';

/** Minimum reputation before auto-deprecation. */
const DEPRECATION_THRESHOLD = -20;

/** Known chain methods for correctness checks. */
const CHAIN_METHODS: Record<string, { method: string; params: unknown[] }> = {
  solana: { method: 'getHealth', params: [] },
  ethereum: { method: 'eth_blockNumber', params: [] },
  base: { method: 'eth_blockNumber', params: [] },
  secret: { method: 'status', params: [] },
};

export interface RpcTestSummary {
  rpcId: number;
  url: string;
  chain: string;
  success: boolean;
  latencyMs: number | null;
  error: string | null;
  newReputation: number;
  deprecated: boolean;
}

export class RpcTester {
  private registry: RpcRegistry;

  constructor(registry: RpcRegistry) {
    this.registry = registry;
  }

  /** Test a single RPC endpoint. */
  async testOne(rpc: RpcEntry): Promise<RpcTestSummary> {
    const start = Date.now();
    let success = false;
    let latencyMs: number | null = null;
    let error: string | null = null;

    try {
      const rpcMethod = CHAIN_METHODS[rpc.chain] ?? { method: 'eth_blockNumber', params: [] };

      const res = await fetch(rpc.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: rpcMethod.method,
          params: rpcMethod.params,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      latencyMs = Date.now() - start;

      if (!res.ok) {
        error = `HTTP ${res.status}`;
      } else {
        const body = (await res.json()) as { result?: unknown; error?: { message: string } };
        if (body.error) {
          error = body.error.message;
        } else {
          success = true;
        }
      }
    } catch (err) {
      latencyMs = Date.now() - start;
      error = err instanceof Error ? err.message : String(err);
    }

    // Record result and get new reputation
    this.registry.recordTestResult(rpc.id, { success, latencyMs, error });
    const updated = this.registry.getById(rpc.id);
    const newReputation = updated?.reputation ?? 0;

    // Auto-deprecate if reputation too low
    let deprecated = false;
    if (newReputation <= DEPRECATION_THRESHOLD && updated?.status !== 'deprecated') {
      this.registry.setStatus(rpc.id, 'deprecated');
      deprecated = true;
    }

    // Promote trial → active after 10+ reputation
    if (updated?.status === 'trial' && newReputation >= 10) {
      this.registry.setStatus(rpc.id, 'active');
    }

    return {
      rpcId: rpc.id,
      url: rpc.url,
      chain: rpc.chain,
      success,
      latencyMs,
      error,
      newReputation,
      deprecated,
    };
  }

  /** Test all non-deprecated RPCs. */
  async testAll(): Promise<RpcTestSummary[]> {
    const rpcs = this.registry.listAll();
    const active = rpcs.filter((r) => r.status !== 'deprecated');
    const results: RpcTestSummary[] = [];

    // Test sequentially to avoid overwhelming the network
    for (const rpc of active) {
      results.push(await this.testOne(rpc));
    }

    return results;
  }

  /** Test all RPCs for a specific chain. */
  async testChain(chain: string): Promise<RpcTestSummary[]> {
    const rpcs = this.registry.listByChain(chain);
    const results: RpcTestSummary[] = [];

    for (const rpc of rpcs) {
      results.push(await this.testOne(rpc));
    }

    return results;
  }
}
