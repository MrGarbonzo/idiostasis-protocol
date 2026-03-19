import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { X402Client } from './client.js';
import type { HttpFetcher } from './client.js';
import { X402PaymentFailedError, buildX402Wallet } from './types.js';
import type { EvmWallet } from './types.js';

function makeWallet(): EvmWallet {
  return {
    address: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
    async signMessage(message: string) { return `sig:${message.slice(0, 16)}`; },
    async signTypedData() { return '0xdeadbeef'; },
  };
}

function makePaymentHeaders(terms: Record<string, unknown>): Headers {
  const encoded = Buffer.from(JSON.stringify(terms)).toString('base64');
  const headers = new Headers();
  headers.set('payment-required', encoded);
  return headers;
}

function makeResponse(status: number, body?: unknown, statusText?: string, headers?: Headers): Response {
  return new Response(
    body !== undefined ? JSON.stringify(body) : null,
    {
      status,
      statusText: statusText ?? (status === 200 ? 'OK' : 'Error'),
      headers: headers ?? undefined,
    },
  );
}

function make402WithHeader(terms: Record<string, unknown>): Response {
  return makeResponse(402, undefined, 'Payment Required', makePaymentHeaders(terms));
}

function makeFetcher(responses: Response[]): HttpFetcher {
  let callIndex = 0;
  return {
    async fetch() {
      return responses[callIndex++];
    },
  };
}

describe('X402Client', () => {
  it('fetchWithPayment returns response on 200', async () => {
    const fetcher = makeFetcher([makeResponse(200, { data: 'ok' })]);
    const client = new X402Client(makeWallet(), undefined, fetcher);
    const res = await client.fetchWithPayment('http://example.com');
    assert.equal(res.status, 200);
    const body = await res.json() as { data: string };
    assert.equal(body.data, 'ok');
  });

  it('fetchWithPayment pays and retries on 402', async () => {
    const terms = {
      accepts: [{
        scheme: 'exact',
        network: 'eip155:8453',
        amount: '1000',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0xdest123',
        maxTimeoutSeconds: 300,
      }],
    };
    const fetcher = makeFetcher([
      make402WithHeader(terms),
      makeResponse(200, { data: 'paid' }),
    ]);
    const client = new X402Client(makeWallet(), undefined, fetcher);
    const res = await client.fetchWithPayment('http://example.com');
    assert.equal(res.status, 200);
  });

  it('fetchWithPayment throws X402PaymentFailedError on second 402', async () => {
    const terms = {
      accepts: [{
        scheme: 'exact',
        network: 'eip155:8453',
        amount: '1000',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0xdest123',
        maxTimeoutSeconds: 300,
      }],
    };
    const fetcher = makeFetcher([
      make402WithHeader(terms),
      make402WithHeader(terms),
    ]);
    const client = new X402Client(makeWallet(), undefined, fetcher);
    await assert.rejects(
      () => client.fetchWithPayment('http://example.com'),
      (err: Error) => {
        assert.ok(err instanceof X402PaymentFailedError);
        assert.equal(err.terms.amount, 1000);
        assert.equal(err.terms.currency, 'USDC');
        return true;
      },
    );
  });

  it('is402 correctly identifies 402 status', () => {
    const client = new X402Client(makeWallet());
    assert.equal(client.is402(makeResponse(402)), true);
    assert.equal(client.is402(makeResponse(200)), false);
    assert.equal(client.is402(makeResponse(500)), false);
  });

  it('getPaymentTerms parses base64 payment-required header', async () => {
    const client = new X402Client(makeWallet());
    const schemeObj = {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '5000',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: '0xrecipient-address',
      maxTimeoutSeconds: 300,
    };
    const terms = { accepts: [schemeObj] };
    const response = make402WithHeader(terms);
    const parsed = await client.getPaymentTerms(response);
    assert.equal(parsed.amount, 5000);
    assert.equal(parsed.currency, 'USDC');
    assert.equal(parsed.chain, 'eip155:8453');
    assert.equal(parsed.payTo, '0xrecipient-address');
    assert.equal(parsed.asset, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    assert.equal(parsed.maxTimeout, 300);
    assert.equal(parsed.method, 'exact');
    assert.deepEqual(parsed.acceptedScheme, schemeObj);
  });

  it('getPaymentTerms falls back to body parsing', async () => {
    const client = new X402Client(makeWallet());
    const response = makeResponse(402, {
      amount: 100,
      currency: 'USDC',
      payTo: '0xaddr',
    });
    const parsed = await client.getPaymentTerms(response);
    assert.equal(parsed.amount, 100);
    assert.equal(parsed.chain, 'eip155:8453');
  });

  it('buildX402Wallet returns wallet with correct address and signTypedData', () => {
    // Known test private key — never use in production
    const testKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const wallet = buildX402Wallet(testKey);
    assert.ok(wallet.address.startsWith('0x'));
    assert.equal(wallet.address.length, 42);
    assert.equal(typeof wallet.signMessage, 'function');
    assert.equal(typeof wallet.signTypedData, 'function');
  });
});
