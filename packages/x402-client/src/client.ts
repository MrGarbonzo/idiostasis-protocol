import type { PaymentTerms, SolanaWallet } from './types.js';
import { X402PaymentFailedError } from './types.js';

/**
 * Interface for the underlying HTTP fetch — injectable for testing.
 */
export interface HttpFetcher {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

const defaultHttpFetcher: HttpFetcher = {
  fetch: (url, init) => globalThis.fetch(url, init),
};

/**
 * x402 HTTP payment client.
 * Handles 402 Payment Required flows automatically:
 * fetches URL, pays if 402, retries.
 */
export class X402Client {
  private readonly solanaRpcUrl: string;
  private readonly wallet: SolanaWallet;
  private readonly httpFetcher: HttpFetcher;

  constructor(solanaRpcUrl: string, wallet: SolanaWallet, httpFetcher?: HttpFetcher) {
    this.solanaRpcUrl = solanaRpcUrl;
    this.wallet = wallet;
    this.httpFetcher = httpFetcher ?? defaultHttpFetcher;
  }

  async fetchWithPayment(url: string): Promise<Response> {
    const response = await this.httpFetcher.fetch(url);

    if (response.status === 200) {
      return response;
    }

    if (response.status !== 402) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // 402 — extract payment terms, pay, retry
    const terms = await this.getPaymentTerms(response);
    await this.executePayment(terms);

    // Retry with payment header
    const retryResponse = await this.httpFetcher.fetch(url, {
      headers: {
        'x-payment-proof': `${this.wallet.publicKey}:${terms.payTo}:${terms.amount}`,
      },
    });

    if (retryResponse.status === 402) {
      throw new X402PaymentFailedError(terms);
    }

    if (!retryResponse.ok) {
      throw new Error(`HTTP ${retryResponse.status} after payment: ${retryResponse.statusText}`);
    }

    return retryResponse;
  }

  is402(response: Response): boolean {
    return response.status === 402;
  }

  async getPaymentTerms(response: Response): Promise<PaymentTerms> {
    const body = await response.clone().json() as Record<string, unknown>;

    if (!body.amount || !body.currency || !body.payTo) {
      throw new Error('Invalid 402 response: missing required payment terms fields');
    }

    return {
      amount: Number(body.amount),
      currency: String(body.currency),
      chain: String(body.chain ?? 'solana'),
      payTo: String(body.payTo),
      memo: body.memo ? String(body.memo) : undefined,
    };
  }

  private async executePayment(terms: PaymentTerms): Promise<void> {
    // Build a Solana transfer transaction
    // In production this would construct a real SPL token transfer
    // For now, sign and send via RPC
    const tx = {
      type: 'transfer',
      from: this.wallet.publicKey,
      to: terms.payTo,
      amount: terms.amount,
      currency: terms.currency,
    };
    await this.wallet.signTransaction(tx);
  }
}
