import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ERC8004Client,
  ERC8004_REGISTRY_ADDRESS_BASE_SEPOLIA,
  encodeMetadataToDataUri,
  decodeDataUri,
} from './client.js';
import type { EvmWallet, ServiceRecord } from './types.js';

// ERC-721 Transfer event topic
const TRANSFER_EVENT_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const mockWallet: EvmWallet = {
  address: '0x1234567890abcdef1234567890abcdef12345678',
  account: { address: '0x1234567890abcdef1234567890abcdef12345678' },
  signTransaction: async () => '0x',
};

/**
 * Testable subclass that overrides protected contract methods
 * so no real RPC calls are made.
 */
class TestableERC8004Client extends ERC8004Client {
  mockTokenURIs = new Map<number, string>();
  mockOwners = new Map<number, string>();
  writeCalls: Array<{ fn: string; args: unknown[] }> = [];
  mockReceiptTokenId = 1;
  readCallLog: Array<{ fn: string; args: unknown[] }> = [];

  constructor() {
    super('http://test.local', '0x' + '0'.repeat(40));
  }

  setMockRegistration(
    tokenId: number,
    metadata: { name: string; description: string; services: ServiceRecord[]; active?: boolean },
    owner = '0x1234567890abcdef1234567890abcdef12345678',
  ) {
    const full = {
      type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
      x402Support: true,
      active: true,
      ...metadata,
    };
    this.mockTokenURIs.set(tokenId, encodeMetadataToDataUri(full as any));
    this.mockOwners.set(tokenId, owner);
  }

  protected async contractRead(fn: string, args: readonly unknown[]): Promise<unknown> {
    this.readCallLog.push({ fn, args: [...args] });
    if (fn === 'tokenURI') {
      const tokenId = Number(args[0]);
      const uri = this.mockTokenURIs.get(tokenId);
      if (uri === undefined) throw new Error('ERC721: invalid token ID');
      return uri;
    }
    if (fn === 'ownerOf') {
      const tokenId = Number(args[0]);
      const owner = this.mockOwners.get(tokenId);
      if (!owner) throw new Error('ERC721: invalid token ID');
      return owner;
    }
    throw new Error(`Unexpected contractRead: ${fn}`);
  }

  protected async contractWrite(fn: string, args: readonly unknown[]): Promise<`0x${string}`> {
    this.writeCalls.push({ fn, args: [...args] });
    return `0x${'ab'.repeat(32)}` as `0x${string}`;
  }

  protected async txReceipt(): Promise<any> {
    const tokenIdHex = '0x' + this.mockReceiptTokenId.toString(16).padStart(64, '0');
    return {
      logs: [{
        topics: [
          TRANSFER_EVENT_TOPIC,
          '0x' + '0'.repeat(64),
          '0x' + '0'.repeat(24) + mockWallet.address.slice(2),
          tokenIdHex,
        ],
        data: '0x',
      }],
    };
  }
}

let client: TestableERC8004Client;

beforeEach(() => {
  client = new TestableERC8004Client();
});

describe('register', () => {
  it('builds correct metadata JSON with all three services', async () => {
    client.mockReceiptTokenId = 42;
    const services: ServiceRecord[] = [
      { name: 'teequote', endpoint: 'https://agent.test:29343/cpu.html' },
      { name: 'workload', endpoint: 'https://agent.test/workload' },
      { name: 'discovery', endpoint: 'https://agent.test/discover' },
    ];

    await client.register({
      name: 'test-agent',
      description: 'A test agent',
      services,
      wallet: mockWallet,
    });

    assert.equal(client.writeCalls.length, 1);
    assert.equal(client.writeCalls[0].fn, 'register');
    const dataUri = client.writeCalls[0].args[0] as string;
    const metadata = decodeDataUri(dataUri);
    assert.ok(metadata);
    assert.equal(metadata.name, 'test-agent');
    assert.equal(metadata.description, 'A test agent');
    assert.equal(metadata.services.length, 3);
    assert.equal(metadata.services[0].name, 'teequote');
    assert.equal(metadata.services[1].name, 'workload');
    assert.equal(metadata.services[2].name, 'discovery');
    assert.equal(metadata.type, 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1');
    assert.equal(metadata.x402Support, true);
    assert.equal(metadata.active, true);
    assert.deepStrictEqual(metadata.supportedTrust, ['tee-attestation']);
  });

  it('base64-encodes metadata into data URI correctly', async () => {
    client.mockReceiptTokenId = 1;
    await client.register({
      name: 'agent',
      description: 'desc',
      services: [{ name: 'discovery', endpoint: 'https://a.test/d' }],
      wallet: mockWallet,
    });

    const dataUri = client.writeCalls[0].args[0] as string;
    assert.ok(dataUri.startsWith('data:application/json;base64,'));
    const base64Part = dataUri.slice('data:application/json;base64,'.length);
    const decoded = JSON.parse(Buffer.from(base64Part, 'base64').toString('utf-8'));
    assert.equal(decoded.name, 'agent');
    assert.equal(decoded.description, 'desc');
  });

  it('parses tokenId from Transfer event log', async () => {
    client.mockReceiptTokenId = 99;
    const result = await client.register({
      name: 'agent',
      description: 'desc',
      services: [],
      wallet: mockWallet,
    });
    assert.equal(result.tokenId, 99);
    assert.equal(result.txHash, `0x${'ab'.repeat(32)}`);
  });
});

describe('updateEndpoint', () => {
  it('reads existing metadata and updates correct service', async () => {
    client.setMockRegistration(5, {
      name: 'agent-5',
      description: 'Test',
      services: [
        { name: 'discovery', endpoint: 'https://old.test/discover' },
        { name: 'workload', endpoint: 'https://old.test/workload' },
      ],
    });

    await client.updateEndpoint(5, 'discovery', 'https://new.test/discover', mockWallet);

    assert.equal(client.writeCalls.length, 1);
    assert.equal(client.writeCalls[0].fn, 'setTokenURI');
    const newUri = client.writeCalls[0].args[1] as string;
    const metadata = decodeDataUri(newUri);
    assert.ok(metadata);
    assert.equal(metadata.services.length, 2);
    const disc = metadata.services.find(s => s.name === 'discovery');
    assert.equal(disc!.endpoint, 'https://new.test/discover');
    const work = metadata.services.find(s => s.name === 'workload');
    assert.equal(work!.endpoint, 'https://old.test/workload');
  });

  it('adds new service if name not found', async () => {
    client.setMockRegistration(7, {
      name: 'agent-7',
      description: 'Test',
      services: [
        { name: 'discovery', endpoint: 'https://a.test/discover' },
      ],
    });

    await client.updateEndpoint(7, 'teequote', 'https://a.test:29343/cpu.html', mockWallet);

    const newUri = client.writeCalls[0].args[1] as string;
    const metadata = decodeDataUri(newUri);
    assert.ok(metadata);
    assert.equal(metadata.services.length, 2);
    assert.ok(metadata.services.find(s => s.name === 'teequote'));
    assert.equal(
      metadata.services.find(s => s.name === 'teequote')!.endpoint,
      'https://a.test:29343/cpu.html',
    );
  });
});

describe('getRegistration', () => {
  it('returns null on contract revert', async () => {
    // No mock set up — contractRead will throw for unknown tokenId
    const result = await client.getRegistration(999);
    assert.equal(result, null);
  });

  it('correctly decodes data URI metadata', async () => {
    client.setMockRegistration(3, {
      name: 'agent-3',
      description: 'A real agent',
      services: [
        { name: 'discovery', endpoint: 'https://agent3.test/discover' },
        { name: 'workload', endpoint: 'https://agent3.test/workload' },
      ],
    });

    const reg = await client.getRegistration(3);
    assert.ok(reg);
    assert.equal(reg.tokenId, 3);
    assert.equal(reg.name, 'agent-3');
    assert.equal(reg.description, 'A real agent');
    assert.equal(reg.services.length, 2);
    assert.equal(reg.active, true);
    assert.equal(reg.owner, '0x1234567890abcdef1234567890abcdef12345678');
  });

  it('returns null for invalid JSON in tokenURI', async () => {
    // Set a non-data-URI value
    client.mockTokenURIs.set(10, 'https://example.com/metadata.json');
    client.mockOwners.set(10, '0x1234');

    const reg = await client.getRegistration(10);
    assert.equal(reg, null);
  });
});

describe('findByRtmr3', () => {
  it('returns empty array (stub — requires event indexing)', async () => {
    const results = await client.findByRtmr3('abc123');
    assert.equal(results.length, 0);
  });
});

describe('getLivePrimaryAddress', () => {
  it('returns null for inactive registration', async () => {
    client.setMockRegistration(1, {
      name: 'inactive',
      description: '',
      services: [{ name: 'discovery', endpoint: 'https://a.test/discover' }],
      active: false,
    });

    const result = await client.getLivePrimaryAddress(1);
    assert.equal(result, null);
  });

  it('returns discovery endpoint for active registration', async () => {
    client.setMockRegistration(2, {
      name: 'active',
      description: '',
      services: [
        { name: 'discovery', endpoint: 'https://primary.test:8080/discover' },
        { name: 'workload', endpoint: 'https://primary.test:8080/workload' },
      ],
    });

    const result = await client.getLivePrimaryAddress(2);
    assert.equal(result, 'https://primary.test:8080/discover');
  });
});

describe('registry address', () => {
  it('ERC8004_REGISTRY_ADDRESS_BASE_SEPOLIA is not the zero address', () => {
    assert.notEqual(ERC8004_REGISTRY_ADDRESS_BASE_SEPOLIA, '0x0000000000000000000000000000000000000000');
    assert.ok(ERC8004_REGISTRY_ADDRESS_BASE_SEPOLIA.startsWith('0x'));
  });
});

describe('isActive', () => {
  it('returns correct boolean', async () => {
    client.setMockRegistration(1, {
      name: 'a1',
      description: '',
      services: [],
      active: true,
    });
    client.setMockRegistration(2, {
      name: 'a2',
      description: '',
      services: [],
      active: false,
    });

    assert.equal(await client.isActive(1), true);
    assert.equal(await client.isActive(2), false);
    assert.equal(await client.isActive(999), false); // nonexistent
  });
});
