/**
 * Local agent→agent handoff test on Base Sepolia.
 *
 * Simulates the full failover sequence using two wallets:
 *   1. Primary registers on-chain
 *   2. Backup discovers primary via getAgents()
 *   3. Primary deactivates (simulates guardian-triggered deactivation)
 *   4. Backup confirms no active agents remain
 *   5. Backup registers itself as the new primary
 *   6. Verify backup is now the only active agent
 *
 * Usage:
 *   DEPLOYER_KEY=0x... CONTRACT_ADDRESS=0x... npx tsx scripts/test-handoff.ts
 */
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { ERC8004RegistryClient } from '../src/registry/erc8004-registry-client.js';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { baseSepolia } from 'viem/chains';

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
  const deployerKey = env('DEPLOYER_KEY') as `0x${string}`;
  const contractAddress = env('CONTRACT_ADDRESS') as `0x${string}`;

  // ── Set up two wallets: primary (deployer) and backup (fresh) ──
  const primaryAccount = privateKeyToAccount(deployerKey);
  const backupKey = generatePrivateKey();
  const backupAccount = privateKeyToAccount(backupKey);

  console.log(`Primary wallet:  ${primaryAccount.address}`);
  console.log(`Backup wallet:   ${backupAccount.address}`);
  console.log(`Contract:        ${contractAddress}\n`);

  // Fund backup wallet from primary (needs gas for register tx)
  console.log('0) Funding backup wallet with 0.001 ETH...');
  const walletClient = createWalletClient({
    account: primaryAccount,
    chain: baseSepolia,
    transport: http(RPC_URL),
  });
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(RPC_URL),
  });

  const fundTx = await walletClient.sendTransaction({
    to: backupAccount.address,
    value: parseEther('0.001'),
  });
  await publicClient.waitForTransactionReceipt({ hash: fundTx });
  console.log(`   tx: ${fundTx}`);
  await sleep(5000);

  // Create clients for both wallets
  const primaryClient = new ERC8004RegistryClient(RPC_URL, primaryAccount, contractAddress);
  const backupClient = new ERC8004RegistryClient(RPC_URL, backupAccount, contractAddress);

  // ── 1. Primary registers on-chain ──────────────────────────
  console.log('\n1) Primary registers as agent...');
  const regTx = await primaryClient.registerSelf({
    entityType: 'agent',
    endpoint: 'http://primary-agent.local:8080',
    teeInstanceId: 'aaaa111122223333',
    codeHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    attestationHash: '1111111111111111111111111111111111111111111111111111111111111111',
    ed25519Pubkey: Buffer.from('abcd'.repeat(8), 'hex').toString('base64'),
    isActive: true,
  });
  console.log(`   tx: ${regTx}`);
  await sleep(5000);

  // ── 2. Backup discovers primary via getAgents() ────────────
  console.log('\n2) Backup discovers primary via registry...');
  const agents = await backupClient.getAgents();
  if (agents.length === 0) throw new Error('Backup found no agents in registry');
  const primary = agents.find(
    (a) => a.owner.toLowerCase() === primaryAccount.address.toLowerCase(),
  );
  if (!primary) throw new Error('Primary agent not found in registry');
  console.log(`   Found primary at: ${primary.endpoint}`);
  console.log(`   TEE ID: ${primary.teeInstanceId}`);
  console.log(`   isActive: ${primary.isActive}`);

  // ── 3. Primary deactivates (simulates crash + guardian deactivation) ──
  console.log('\n3) Primary deactivates (simulating failure)...');
  const deactTx = await primaryClient.deactivate();
  console.log(`   tx: ${deactTx}`);
  await sleep(5000);

  // ── 4. Backup confirms no active agents ────────────────────
  console.log('\n4) Backup checks registry — should be empty...');
  const agentsAfterDeact = await backupClient.getAgents();
  const activeCount = agentsAfterDeact.length;
  console.log(`   Active agents: ${activeCount}`);
  if (activeCount > 0) {
    throw new Error(`Expected 0 active agents, got ${activeCount}`);
  }

  // ── 5. Backup registers itself as new primary ──────────────
  console.log('\n5) Backup registers as new primary agent...');
  const backupRegTx = await backupClient.registerSelf({
    entityType: 'agent',
    endpoint: 'http://backup-agent.local:8080',
    teeInstanceId: 'bbbb444455556666',
    codeHash: 'cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe',
    attestationHash: '2222222222222222222222222222222222222222222222222222222222222222',
    ed25519Pubkey: Buffer.from('1234'.repeat(8), 'hex').toString('base64'),
    isActive: true,
  });
  console.log(`   tx: ${backupRegTx}`);
  await sleep(5000);

  // ── 6. Verify backup is now the only active agent ──────────
  console.log('\n6) Verify backup is the only active agent...');
  const finalAgents = await backupClient.getAgents();
  console.log(`   Active agents: ${finalAgents.length}`);

  if (finalAgents.length !== 1) {
    throw new Error(`Expected exactly 1 active agent, got ${finalAgents.length}`);
  }

  const newPrimary = finalAgents[0];
  if (newPrimary.owner.toLowerCase() !== backupAccount.address.toLowerCase()) {
    throw new Error(`Expected backup as owner, got ${newPrimary.owner}`);
  }
  console.log(`   Owner: ${newPrimary.owner} (backup wallet)`);
  console.log(`   Endpoint: ${newPrimary.endpoint}`);
  console.log(`   TEE ID: ${newPrimary.teeInstanceId}`);

  // ── 7. Verify old primary is deactivated ───────────────────
  console.log('\n7) Verify old primary entry is deactivated...');
  const guardians = await backupClient.getGuardians();
  console.log(`   Guardians: ${guardians.length} (expected 0)`);
  if (guardians.length !== 0) {
    throw new Error(`Expected 0 guardians, got ${guardians.length}`);
  }

  console.log('\n✅ Agent handoff test passed!');
  console.log('   Primary registered → Backup discovered → Primary deactivated →');
  console.log('   Backup took over → Only backup active on-chain');
}

main().catch((err) => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
