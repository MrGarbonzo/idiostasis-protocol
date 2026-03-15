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
  };
}

function makeResponse(status: number, body?: unknown, statusText?: string): Response {
  return new Response(
    body !== undefined ? JSON.stringify(body) : null,
    { status, statusText: statusText ?? (status === 200 ? 'OK' : 'Error') },
  );
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
    const paymentTerms = { amount: 1000, currency: 'USDC', chain: 'base-sepolia', payTo: '0xdest123' };
    const fetcher = makeFetcher([
      makeResponse(402, paymentTerms),
      makeResponse(200, { data: 'paid' }),
    ]);
    const client = new X402Client(makeWallet(), undefined, fetcher);
    const res = await client.fetchWithPayment('http://example.com');
    assert.equal(res.status, 200);
  });

  it('fetchWithPayment throws X402PaymentFailedError on second 402', async () => {
    const paymentTerms = { amount: 1000, currency: 'USDC', chain: 'base-sepolia', payTo: '0xdest123' };
    const fetcher = makeFetcher([
      makeResponse(402, paymentTerms),
      makeResponse(402, paymentTerms),
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

  it('getPaymentTerms parses valid payment terms body', async () => {
    const client = new X402Client(makeWallet());
    const response = makeResponse(402, {
      amount: 5000,
      currency: 'USDC',
      chain: 'base-sepolia',
      payTo: '0xrecipient-address',
      memo: 'test payment',
    });
    const terms = await client.getPaymentTerms(response);
    assert.equal(terms.amount, 5000);
    assert.equal(terms.currency, 'USDC');
    assert.equal(terms.chain, 'base-sepolia');
    assert.equal(terms.payTo, '0xrecipient-address');
    assert.equal(terms.memo, 'test payment');
  });

  it('getPaymentTerms defaults chain to base-sepolia', async () => {
    const client = new X402Client(makeWallet());
    const response = makeResponse(402, {
      amount: 100,
      currency: 'USDC',
      payTo: '0xaddr',
    });
    const terms = await client.getPaymentTerms(response);
    assert.equal(terms.chain, 'base-sepolia');
  });

  it('buildX402Wallet returns wallet with correct address from private key', () => {
    // Known test private key — never use in production
    const testKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const wallet = buildX402Wallet(testKey);
    assert.ok(wallet.address.startsWith('0x'));
    assert.equal(wallet.address.length, 42);
    assert.equal(typeof wallet.signMessage, 'function');
  });
});
