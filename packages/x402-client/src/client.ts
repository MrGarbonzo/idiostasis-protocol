import type { EvmWallet, PaymentTerms } from './types.js';
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
 * x402 HTTP payment client (EVM / Base chain).
 * Handles 402 Payment Required flows automatically:
 * fetches URL, pays if 402, retries.
 */
export class X402Client {
  private readonly wallet: EvmWallet;
  private readonly facilitatorUrl: string | undefined;
  private readonly httpFetcher: HttpFetcher;

  constructor(
    wallet: EvmWallet,
    facilitatorUrl?: string,
    httpFetcher?: HttpFetcher,
  ) {
    this.wallet = wallet;
    this.facilitatorUrl = facilitatorUrl;
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

    // 402 — extract payment terms, sign payment, retry
    const terms = await this.getPaymentTerms(response);
    const paymentSignature = await this.signPayment(terms);

    // Retry with payment header
    const retryResponse = await this.httpFetcher.fetch(url, {
      headers: {
        'x-payment': paymentSignature,
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
      chain: String(body.chain ?? 'base-sepolia'),
      payTo: String(body.payTo),
      memo: body.memo ? String(body.memo) : undefined,
    };
  }

  /**
   * Sign a payment authorization for the given terms.
   * Returns a compact proof string: `{walletAddress}:{payTo}:{amount}:{signature}`.
   */
  private async signPayment(terms: PaymentTerms): Promise<string> {
    const message = `x402:${terms.payTo}:${terms.amount}:${terms.currency}`;
    const signature = await this.wallet.signMessage(message);
    return `${this.wallet.address}:${terms.payTo}:${terms.amount}:${signature}`;
  }
}
