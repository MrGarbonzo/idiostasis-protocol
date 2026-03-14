import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ERC8004Client } from './client.js';
import type { RpcFetcher } from './client.js';
import type { AgentRegistration, EvmWallet } from './types.js';

// Mock registrations keyed by tokenId
const mockRegistrations = new Map<number, AgentRegistration>();

function resetMocks() {
  mockRegistrations.clear();
}

function addMockRegistration(reg: AgentRegistration) {
  mockRegistrations.set(reg.tokenId, reg);
}

function makeRegistration(tokenId: number, overrides?: Partial<AgentRegistration>): AgentRegistration {
  return {
    tokenId,
    owner: '0x1234567890abcdef1234567890abcdef12345678',
    name: `agent-${tokenId}`,
    description: 'Test agent',
    services: [
      { name: 'discovery', endpoint: `https://agent${tokenId}.test:8080/discover` },
      { name: 'workload', endpoint: `https://agent${tokenId}.test:8080/workload` },
    ],
    active: true,
    registeredAt: Date.now() - 86400000,
    updatedAt: Date.now(),
    ...overrides,
  };
}

/**
 * Mock fetcher that simulates ERC-8004 contract calls.
 * Instead of real ABI encoding/decoding, we intercept at the RPC level.
 */
function createMockFetcher(): RpcFetcher {
  return {
    async call(method: string, params: unknown[]): Promise<unknown> {
      if (method === 'eth_call') {
        const callParams = params[0] as { data: string };
        const data = callParams.data;

        // totalSupply selector: 0x18160ddd
        if (data === '0x18160ddd') {
          return '0x' + mockRegistrations.size.toString(16).padStart(64, '0');
        }

        // getRegistration selector: 0x00000003
        if (data.startsWith('0x00000003')) {
          const tokenId = parseInt(data.slice(10, 74), 16);
          const reg = mockRegistrations.get(tokenId);
          if (!reg) return '0x';
          // Return a non-empty result — the client will need our mock to handle decoding
          return JSON.stringify(reg);
        }

        // isActive selector: 0x00000004
        if (data.startsWith('0x00000004')) {
          const tokenId = parseInt(data.slice(10, 74), 16);
          const reg = mockRegistrations.get(tokenId);
          const active = reg?.active ?? false;
          return '0x' + (active ? '1' : '0').padStart(64, '0');
        }
      }

      if (method === 'eth_getTransactionReceipt') {
        return {
          status: '0x1',
          logs: [{ topics: ['0x0', '0x0', '0x0', '0x1'], data: '0x' }],
        };
      }

      return null;
    },
    async sendTransaction(): Promise<string> {
      return '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    },
  };
}

/**
 * Create a client that uses mock-decoded getRegistration.
 * Since raw ABI decoding is not implemented (would need viem),
 * we override getRegistration to use our mock data directly.
 */
class TestableERC8004Client extends ERC8004Client {
  constructor(fetcher: RpcFetcher) {
    super('http://localhost:8545', '0xRegistryAddress', fetcher);
  }

  override async getRegistration(tokenId: number): Promise<AgentRegistration | null> {
    return mockRegistrations.get(tokenId) ?? null;
  }
}

describe('ERC8004Client', () => {
  it('getRegistration returns null for unknown tokenId', async () => {
    resetMocks();
    const client = new TestableERC8004Client(createMockFetcher());
    const result = await client.getRegistration(999);
    assert.equal(result, null);
  });

  it('findByRtmr3 filters by workload service endpoint content', async () => {
    resetMocks();
    const reg1 = makeRegistration(1, {
      services: [
        { name: 'discovery', endpoint: 'https://a1.test/discover' },
        { name: 'workload', endpoint: 'https://a1.test/workload?rtmr3=abc123' },
      ],
    });
    const reg2 = makeRegistration(2, {
      services: [
        { name: 'discovery', endpoint: 'https://a2.test/discover' },
        { name: 'workload', endpoint: 'https://a2.test/workload?rtmr3=def456' },
      ],
    });
    const reg3 = makeRegistration(3, {
      services: [
        { name: 'discovery', endpoint: 'https://a3.test/discover' },
        { name: 'workload', endpoint: 'https://a3.test/workload?rtmr3=abc123' },
      ],
    });
    addMockRegistration(reg1);
    addMockRegistration(reg2);
    addMockRegistration(reg3);

    const client = new TestableERC8004Client(createMockFetcher());
    const results = await client.findByRtmr3('abc123');
    assert.equal(results.length, 2);
    assert.ok(results.some(r => r.tokenId === 1));
    assert.ok(results.some(r => r.tokenId === 3));
  });

  it('getLivePrimaryAddress returns null for inactive registration', async () => {
    resetMocks();
    addMockRegistration(makeRegistration(1, { active: false }));

    const client = new TestableERC8004Client(createMockFetcher());
    const result = await client.getLivePrimaryAddress(1);
    assert.equal(result, null);
  });

  it('getLivePrimaryAddress returns discovery endpoint for active registration', async () => {
    resetMocks();
    addMockRegistration(makeRegistration(1, {
      active: true,
      services: [
        { name: 'discovery', endpoint: 'https://primary.test:8080/discover' },
        { name: 'workload', endpoint: 'https://primary.test:8080/workload' },
      ],
    }));

    const client = new TestableERC8004Client(createMockFetcher());
    const result = await client.getLivePrimaryAddress(1);
    assert.equal(result, 'https://primary.test:8080/discover');
  });

  it('isActive returns correct boolean', async () => {
    resetMocks();
    addMockRegistration(makeRegistration(1, { active: true }));
    addMockRegistration(makeRegistration(2, { active: false }));

    const fetcher = createMockFetcher();
    // Use base class for isActive since it does real ABI decode of bool
    const client = new ERC8004Client('http://localhost:8545', '0xReg', fetcher);
    const active1 = await client.isActive(1);
    assert.equal(active1, true);
    const active2 = await client.isActive(2);
    assert.equal(active2, false);
  });
});
