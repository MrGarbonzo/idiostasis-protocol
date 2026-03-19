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
    const paymentSignature = await this.signPaymentTerms(terms);

    // Retry with payment header (base64-encoded, per x402v2 spec)
    const encoded = Buffer.from(paymentSignature).toString('base64');
    const retryResponse = await this.httpFetcher.fetch(url, {
      headers: {
        'payment-signature': encoded,
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
    const header = response.headers.get('payment-required')
      ?? response.headers.get('x-payment-required');

    if (header) {
      const decoded = JSON.parse(Buffer.from(header, 'base64').toString()) as Record<string, unknown>;
      const accepts = decoded.accepts as Record<string, unknown>[] | undefined;
      const scheme = (accepts?.[0] ?? decoded) as Record<string, unknown>;
      const extra = scheme.extra as Record<string, unknown> | undefined;
      return {
        amount: Number(scheme.maxAmountRequired ?? scheme.amount),
        currency: 'USDC',
        chain: String(scheme.network ?? 'eip155:8453'),
        payTo: String(scheme.payTo ?? extra?.payTo),
        asset: String(scheme.asset ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
        maxTimeout: Number(scheme.maxTimeoutSeconds ?? 300),
        method: String(scheme.scheme ?? 'eip3009'),
        acceptedScheme: scheme,
      };
    }

    // Fallback: try body
    const body = await response.clone().json() as Record<string, unknown>;
    return {
      amount: Number(body.amount),
      currency: String(body.currency ?? 'USDC'),
      chain: String(body.chain ?? 'eip155:8453'),
      payTo: String(body.payTo),
      asset: String(body.asset ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
      maxTimeout: Number(body.maxTimeout ?? 300),
    };
  }

  /**
   * Sign an EIP-3009 transferWithAuthorization via EIP-712 typed data.
   * Returns a JSON x402 payment header with the signature and authorization params.
   */
  async signPaymentTerms(terms: PaymentTerms): Promise<string> {
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + (terms.maxTimeout ?? 300));
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const nonceHex = `0x${Buffer.from(nonce).toString('hex')}` as `0x${string}`;

    const signature = await this.wallet.signTypedData({
      domain: {
        name: 'USD Coin',
        version: '2',
        chainId: 8453,
        verifyingContract: (terms.asset ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913') as `0x${string}`,
      },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: this.wallet.address as `0x${string}`,
        to: terms.payTo as `0x${string}`,
        value: BigInt(terms.amount),
        validAfter: 0n,
        validBefore,
        nonce: nonceHex,
      },
    });

    return JSON.stringify({
      x402Version: 2,
      scheme: 'exact',
      network: terms.chain ?? 'eip155:8453',
      accepted: terms.acceptedScheme ?? {
        scheme: 'exact',
        network: terms.chain,
        amount: String(terms.amount),
        asset: terms.asset,
        payTo: terms.payTo,
        maxTimeoutSeconds: terms.maxTimeout ?? 300,
      },
      payload: {
        signature,
        authorization: {
          from: this.wallet.address,
          to: terms.payTo,
          value: String(terms.amount),
          validAfter: '0',
          validBefore: String(validBefore),
          nonce: nonceHex,
        },
      },
    });
  }
}
