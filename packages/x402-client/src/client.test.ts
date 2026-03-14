import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { X402Client } from './client.js';
import type { HttpFetcher } from './client.js';
import { X402PaymentFailedError } from './types.js';
import type { SolanaWallet } from './types.js';

function makeWallet(): SolanaWallet {
  return {
    publicKey: 'SoLaNaWaLlEtPuBkEy123',
    async signTransaction() { return 'signed'; },
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
    const client = new X402Client('http://rpc.test', makeWallet(), fetcher);
    const res = await client.fetchWithPayment('http://example.com');
    assert.equal(res.status, 200);
    const body = await res.json() as { data: string };
    assert.equal(body.data, 'ok');
  });

  it('fetchWithPayment pays and retries on 402', async () => {
    const paymentTerms = { amount: 1000, currency: 'USDC', chain: 'solana', payTo: 'dest123' };
    const fetcher = makeFetcher([
      makeResponse(402, paymentTerms),
      makeResponse(200, { data: 'paid' }),
    ]);
    const client = new X402Client('http://rpc.test', makeWallet(), fetcher);
    const res = await client.fetchWithPayment('http://example.com');
    assert.equal(res.status, 200);
  });

  it('fetchWithPayment throws X402PaymentFailedError on second 402', async () => {
    const paymentTerms = { amount: 1000, currency: 'USDC', chain: 'solana', payTo: 'dest123' };
    const fetcher = makeFetcher([
      makeResponse(402, paymentTerms),
      makeResponse(402, paymentTerms),
    ]);
    const client = new X402Client('http://rpc.test', makeWallet(), fetcher);
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
    const client = new X402Client('http://rpc.test', makeWallet());
    assert.equal(client.is402(makeResponse(402)), true);
    assert.equal(client.is402(makeResponse(200)), false);
    assert.equal(client.is402(makeResponse(500)), false);
  });

  it('getPaymentTerms parses valid payment terms body', async () => {
    const client = new X402Client('http://rpc.test', makeWallet());
    const response = makeResponse(402, {
      amount: 5000,
      currency: 'USDC',
      chain: 'solana',
      payTo: 'recipient-address',
      memo: 'test payment',
    });
    const terms = await client.getPaymentTerms(response);
    assert.equal(terms.amount, 5000);
    assert.equal(terms.currency, 'USDC');
    assert.equal(terms.chain, 'solana');
    assert.equal(terms.payTo, 'recipient-address');
    assert.equal(terms.memo, 'test payment');
  });
});
