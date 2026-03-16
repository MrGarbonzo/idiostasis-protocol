import { ERC8004Client } from '../packages/erc8004-client/src/client.js';
import { mnemonicToAccount } from 'viem/accounts';

const tokenId = parseInt(process.env.TOKEN_ID ?? '0');
const mnemonic = process.env.EVM_MNEMONIC ?? '';
const domain = process.env.SECRETVM_DOMAIN ?? '';
const port = process.env.PORT ?? '3001';
const rpcUrl = process.env.BASE_RPC_URL ?? 'https://sepolia.base.org';

if (!tokenId || !mnemonic || !domain) {
  console.error('TOKEN_ID, EVM_MNEMONIC, and SECRETVM_DOMAIN are required');
  process.exit(1);
}

const account = mnemonicToAccount(mnemonic);
const wallet = {
  address: account.address,
  account,
  signTransaction: async (tx: unknown) => account.signTransaction(tx as any),
};

const client = new ERC8004Client(rpcUrl, '0x8004A818BFB912233c491871b3d84c89A494BD9e');

await client.updateEndpoint(tokenId, 'discovery',
  `http://${domain}:${port}/discover`, wallet);
await client.updateEndpoint(tokenId, 'workload',
  `http://${domain}:${port}/workload`, wallet);

console.log('Updated endpoints for token', tokenId);
