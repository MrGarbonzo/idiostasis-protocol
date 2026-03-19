import { privateKeyToAccount } from 'viem/accounts';

export interface PaymentTerms {
  amount: number;
  currency: string;
  chain: string;
  payTo: string;
  memo?: string;
  asset?: string;
  maxTimeout?: number;
  method?: string;
  acceptedScheme?: Record<string, unknown>;
}

export interface EvmWallet {
  address: string;
  signMessage(message: string): Promise<string>;
  signTypedData(params: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<string>;
}

export class X402PaymentFailedError extends Error {
  constructor(public readonly terms: PaymentTerms) {
    super(`x402 payment failed for ${terms.amount} ${terms.currency}`);
    this.name = 'X402PaymentFailedError';
  }
}

/**
 * Build an EvmWallet from a hex private key string.
 * Uses viem's privateKeyToAccount for signing.
 */
export function buildX402Wallet(privateKey: string): EvmWallet {
  const key = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`;
  const account = privateKeyToAccount(key);
  return {
    address: account.address,
    signMessage: (message: string) => account.signMessage({ message }),
    signTypedData: (params) => account.signTypedData(params as any),
  };
}
