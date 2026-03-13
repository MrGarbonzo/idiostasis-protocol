/**
 * Smoke-test script for IdiostasisRegistry on Base Sepolia.
 *
 * Usage:
 *   DEPLOYER_KEY=0x... CONTRACT_ADDRESS=0x... npx tsx scripts/test-registry.ts
 */
import { privateKeyToAccount } from 'viem/accounts';
import { ERC8004RegistryClient } from '../src/registry/erc8004-registry-client.js';

const RPC_URL = 'https://sepolia.base.org';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function env(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const privateKey = env('DEPLOYER_KEY') as `0x${string}`;
  const contractAddress = env('CONTRACT_ADDRESS') as `0x${string}`;

  const account = privateKeyToAccount(privateKey);
  console.log(`Wallet: ${account.address}`);
  console.log(`Contract: ${contractAddress}\n`);

  const client = new ERC8004RegistryClient(RPC_URL, account, contractAddress);

  // ── 1. register() ──────────────────────────────────────────
  console.log('1) register() — minting NFT and storing entry...');
  const regTx = await client.registerSelf({
    entityType: 'agent',
    endpoint: 'http://test-agent.local:8080',
    teeInstanceId: 'aabbccdd11223344',
    codeHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    attestationHash: '1111111111111111111111111111111111111111111111111111111111111111',
    ed25519Pubkey: Buffer.from('abcd'.repeat(8), 'hex').toString('base64'),
    isActive: true,
  });
  console.log(`   tx: ${regTx}`);
  await sleep(5000); // wait for RPC state + nonce sync

  // ── 2. getAgents() ─────────────────────────────────────────
  console.log('\n2) getAgents() — fetching registered agents...');
  const agents = await client.getAgents();
  if (agents.length === 0) throw new Error('Expected at least 1 agent');
  const agent = agents[agents.length - 1];
  console.log(`   Found ${agents.length} agent(s)`);
  console.log(`   endpoint: ${agent.endpoint}`);
  console.log(`   entityType: ${agent.entityType}`);
  console.log(`   isActive: ${agent.isActive}`);
  if (agent.endpoint !== 'http://test-agent.local:8080') {
    throw new Error(`Endpoint mismatch: ${agent.endpoint}`);
  }

  // ── 3. sendHeartbeat() ─────────────────────────────────────
  console.log('\n3) sendHeartbeat() — updating lastHeartbeat...');
  const hbTx = await client.sendHeartbeat();
  console.log(`   tx: ${hbTx}`);
  await sleep(5000);

  // Verify heartbeat updated
  const agentsAfterHb = await client.getAgents();
  const agentAfterHb = agentsAfterHb[agentsAfterHb.length - 1];
  console.log(`   lastHeartbeat: ${agentAfterHb.lastHeartbeat}`);
  if (agentAfterHb.lastHeartbeat < agent.lastHeartbeat) {
    throw new Error('Heartbeat did not advance');
  }

  // ── 4. updateEndpoint() ────────────────────────────────────
  console.log('\n4) updateEndpoint() — changing endpoint...');
  const newEndpoint = 'http://updated-agent.local:9090';
  const epTx = await client.updateEndpoint(newEndpoint);
  console.log(`   tx: ${epTx}`);
  await sleep(5000);

  const agentsAfterEp = await client.getAgents();
  const agentAfterEp = agentsAfterEp[agentsAfterEp.length - 1];
  console.log(`   endpoint: ${agentAfterEp.endpoint}`);
  if (agentAfterEp.endpoint !== newEndpoint) {
    throw new Error(`Endpoint not updated: ${agentAfterEp.endpoint}`);
  }

  // ── 5. getGuardians() ─────────────────────────────────────
  console.log('\n5) getGuardians() — expecting empty array...');
  const guardians = await client.getGuardians();
  console.log(`   Found ${guardians.length} guardian(s)`);
  if (guardians.length !== 0) {
    throw new Error(`Expected 0 guardians, got ${guardians.length}`);
  }

  // ── 6. deactivate() ───────────────────────────────────────
  console.log('\n6) deactivate() — setting isActive = false...');
  const deactTx = await client.deactivate();
  console.log(`   tx: ${deactTx}`);
  await sleep(5000);

  // ── 7. getActiveByType should no longer include this agent ──
  console.log('\n7) getAgents() after deactivate — should be gone...');
  const agentsAfterDeact = await client.getAgents();
  const stillPresent = agentsAfterDeact.some(
    (a) => a.owner.toLowerCase() === account.address.toLowerCase(),
  );
  console.log(`   Active agents: ${agentsAfterDeact.length}`);
  if (stillPresent) {
    throw new Error('Deactivated agent still appears in getAgents()');
  }

  console.log('\n✅ All 7 checks passed!');
}

main().catch((err) => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
