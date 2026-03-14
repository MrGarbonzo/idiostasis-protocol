export interface PaymentTerms {
  amount: number;
  currency: string;
  chain: string;
  payTo: string;
  memo?: string;
}

export interface SolanaWallet {
  publicKey: string;
  signTransaction(tx: unknown): Promise<unknown>;
}

export class X402PaymentFailedError extends Error {
  constructor(public readonly terms: PaymentTerms) {
    super(`x402 payment failed for ${terms.amount} ${terms.currency}`);
    this.name = 'X402PaymentFailedError';
  }
}
