import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';

async function main() {

const REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const TOKEN_ID = 2099;

const ABI = [{
  type: 'function',
  name: 'tokenURI',
  inputs: [{ name: 'tokenId', type: 'uint256' }],
  outputs: [{ name: '', type: 'string' }],
  stateMutability: 'view',
}] as const;

const client = createPublicClient({
  chain: baseSepolia,
  transport: http('https://sepolia.base.org'),
});

const uri = await client.readContract({
  address: REGISTRY,
  abi: ABI,
  functionName: 'tokenURI',
  args: [BigInt(TOKEN_ID)],
}) as string;

const prefix = 'data:application/json;base64,';
const json = JSON.parse(Buffer.from(uri.slice(prefix.length), 'base64').toString());
console.log('Name:', json.name);
console.log('Services:');
for (const s of json.services) {
  console.log(`  ${s.name}: ${s.endpoint}`);
}

const discoveryUrl = json.services.find((s: {name: string}) => s.name === 'discovery')?.endpoint;
if (discoveryUrl) {
  const statusUrl = discoveryUrl.replace('/discover', '/network-status');
  console.log('\nFetching network status from:', statusUrl);
  try {
    const statusRes = await fetch(statusUrl, { signal: AbortSignal.timeout(5000) });
    const status = await statusRes.json();
    console.log(JSON.stringify(status, null, 2));
  } catch (err) {
    console.log('Network status unavailable (agent may be offline):', err);
  }
}
}

main().catch(err => { console.error(err); process.exit(1); });
