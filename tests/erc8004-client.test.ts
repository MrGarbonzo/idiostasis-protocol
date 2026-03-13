import { describe, it, expect } from 'vitest';
import { ERC8004RegistryClient } from '../src/registry/erc8004-registry-client.js';
import { privateKeyToAccount } from 'viem/accounts';

// Just test that the client constructs and has the right interface.
// Actual contract calls require a deployed contract.

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const FAKE_CONTRACT = '0x0000000000000000000000000000000000000001' as const;
const FAKE_RPC = 'http://localhost:8545';

describe('ERC8004RegistryClient', () => {
  it('constructs without error', () => {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);
    const client = new ERC8004RegistryClient(FAKE_RPC, account, FAKE_CONTRACT);
    expect(client).toBeDefined();
  });

  it('exposes the expected interface methods', () => {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);
    const client = new ERC8004RegistryClient(FAKE_RPC, account, FAKE_CONTRACT);

    expect(typeof client.getGuardians).toBe('function');
    expect(typeof client.getAgents).toBe('function');
    expect(typeof client.registerSelf).toBe('function');
    expect(typeof client.sendHeartbeat).toBe('function');
    expect(typeof client.updateEndpoint).toBe('function');
    expect(typeof client.deactivate).toBe('function');
  });
});
