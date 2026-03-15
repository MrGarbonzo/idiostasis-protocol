import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SecretVmClient, stableStringify } from './secretvm.js';
import type { EvmSigningWallet, SecretVmHttpClient } from './secretvm.js';
import { X402Client } from './client.js';
import type { EvmWallet } from './types.js';

function makeEvmWallet(): EvmSigningWallet {
  return {
    address: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
    async signMessage(hash: string) {
      return `sig:${hash.slice(0, 16)}`;
    },
  };
}

function makeX402Wallet(): EvmWallet {
  return {
    address: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
    async signMessage(message: string) { return `sig:${message.slice(0, 16)}`; },
  };
}

function makeResponse(status: number, body?: unknown): Response {
  return new Response(
    body !== undefined ? JSON.stringify(body) : null,
    { status, statusText: status === 200 ? 'OK' : 'Error' },
  );
}

function sha256hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

describe('SecretVmClient', () => {
  it('buildHeaders produces correct x-agent-address, x-agent-signature, x-agent-timestamp', async () => {
    const wallet = makeEvmWallet();
    const x402 = new X402Client(makeX402Wallet());
    const client = new SecretVmClient(wallet, x402, 'http://localhost:3000');

    const headers = await client.buildHeaders('GET', '/api/agent/balance', '');

    assert.equal(headers['x-agent-address'], wallet.address);
    assert.ok(headers['x-agent-signature'].startsWith('sig:'));
    assert.ok(headers['x-agent-timestamp'].length > 0);

    // Verify the timestamp is a valid number
    const ts = parseInt(headers['x-agent-timestamp'], 10);
    assert.ok(!Number.isNaN(ts));
    assert.ok(Math.abs(ts - Date.now()) < 5000);

    // Verify the signature was computed from the correct payload
    const expectedPayload = `GET/api/agent/balance${headers['x-agent-timestamp']}`;
    const expectedHash = sha256hex(expectedPayload);
    assert.equal(headers['x-agent-signature'], `sig:${expectedHash.slice(0, 16)}`);
  });

  it('signing payload for createVm uses stableStringify of fields+file metadata, NOT raw form data', () => {
    const wallet = makeEvmWallet();
    const x402 = new X402Client(makeX402Wallet());
    const client = new SecretVmClient(wallet, x402, 'http://localhost:3000');

    const composeYaml = 'version: "3"\nservices:\n  app:\n    image: test:latest\n';
    const params = {
      name: 'test-vm',
      vmTypeId: 'standard',
      dockerComposeYaml: composeYaml,
      fsPersistence: true,
    };

    const signingPayload = client.getCreateVmSigningPayload(params);
    const parsed = JSON.parse(signingPayload) as {
      fields: Record<string, string>;
      file: { fieldname: string; originalname: string; mimetype: string; sha256: string; size: number };
    };

    // Verify fields are present
    assert.equal(parsed.fields.name, 'test-vm');
    assert.equal(parsed.fields.vmTypeId, 'standard');
    assert.equal(parsed.fields.fs_persistence, 'true');

    // Verify file metadata
    assert.equal(parsed.file.fieldname, 'dockercompose');
    assert.equal(parsed.file.originalname, 'docker-compose.yml');
    assert.equal(parsed.file.mimetype, 'application/x-yaml');
    const expectedSize = new TextEncoder().encode(composeYaml).length;
    assert.equal(parsed.file.size, expectedSize);
    const expectedSha256 = sha256hex(new TextEncoder().encode(composeYaml));
    assert.equal(parsed.file.sha256, expectedSha256);

    // Verify keys are sorted (stableStringify)
    const fieldKeys = Object.keys(parsed.fields);
    const sortedFieldKeys = [...fieldKeys].sort();
    assert.deepEqual(fieldKeys, sortedFieldKeys);

    const fileKeys = Object.keys(parsed.file);
    const sortedFileKeys = [...fileKeys].sort();
    assert.deepEqual(fileKeys, sortedFileKeys);

    // Verify the payload does NOT contain multipart boundary strings
    assert.ok(!signingPayload.includes('boundary'));
    assert.ok(!signingPayload.includes('Content-Disposition'));
  });

  it('getBalance returns parsed minor units', async () => {
    const http: SecretVmHttpClient = {
      async fetch() {
        return makeResponse(200, { balance: '5000000' });
      },
    };

    const wallet = makeEvmWallet();
    const x402 = new X402Client(makeX402Wallet());
    const client = new SecretVmClient(wallet, x402, 'http://localhost:3000', http);

    const balance = await client.getBalance();
    assert.equal(balance, 5000000);
  });

  it('addFunds calls x402Client on 402 response', async () => {
    let callCount = 0;
    let x402Called = false;

    const http: SecretVmHttpClient = {
      async fetch() {
        callCount++;
        if (callCount === 1) {
          return makeResponse(402, { amount: 100, currency: 'USDC', payTo: '0xaddr' });
        }
        return makeResponse(200, { balance: '1000000' });
      },
    };

    // Create an x402 client that tracks calls
    const x402Http = {
      async fetch() {
        x402Called = true;
        return makeResponse(200, { paid: true });
      },
    };
    const x402 = new X402Client(makeX402Wallet(), undefined, x402Http);
    const client = new SecretVmClient(makeEvmWallet(), x402, 'http://localhost:3000', http);

    await client.addFunds(1);
    assert.equal(x402Called, true, 'x402Client should have been called for payment');
    assert.ok(callCount >= 2, 'should have retried after payment');
  });

  it('pollUntilRunning resolves when status hits running', async () => {
    let callCount = 0;
    const http: SecretVmHttpClient = {
      async fetch() {
        callCount++;
        if (callCount < 3) {
          return makeResponse(200, {
            id: 'vm-1', name: 'test', status: 'provisioning',
            vmDomain: '', vmId: 'vm-1', vmUid: '',
          });
        }
        return makeResponse(200, {
          id: 'vm-1', name: 'test', status: 'running',
          vmDomain: 'test.vm.scrtlabs.com', vmId: 'vm-1', vmUid: 'uid-1',
        });
      },
    };

    const x402 = new X402Client(makeX402Wallet());
    const client = new SecretVmClient(makeEvmWallet(), x402, 'http://localhost:3000', http);

    const result = await client.pollUntilRunning('vm-1', 10, 5000);
    assert.equal(result.status, 'running');
    assert.equal(result.vmDomain, 'test.vm.scrtlabs.com');
    assert.equal(callCount, 3);
  });

  it('pollUntilRunning throws on timeout', async () => {
    const http: SecretVmHttpClient = {
      async fetch() {
        return makeResponse(200, {
          id: 'vm-1', name: 'test', status: 'provisioning',
          vmDomain: '', vmId: 'vm-1', vmUid: '',
        });
      },
    };

    const x402 = new X402Client(makeX402Wallet());
    const client = new SecretVmClient(makeEvmWallet(), x402, 'http://localhost:3000', http);

    await assert.rejects(
      () => client.pollUntilRunning('vm-1', 10, 50),
      (err: Error) => {
        assert.ok(err.message.includes('timeout'));
        return true;
      },
    );
  });

  it('stopVm calls DELETE /api/agent/vm/:id with signed headers', async () => {
    let method = '';
    let url = '';
    const http: SecretVmHttpClient = {
      async fetch(fetchUrl: string, init?: RequestInit) {
        method = init?.method ?? 'GET';
        url = fetchUrl;
        return makeResponse(200);
      },
    };

    const x402 = new X402Client(makeX402Wallet());
    const client = new SecretVmClient(makeEvmWallet(), x402, 'http://localhost:3000', http);

    await client.stopVm('vm-abc-123');
    assert.equal(method, 'DELETE');
    assert.ok(url.includes('/api/agent/vm/vm-abc-123'));
  });

  it('stopVm treats 404 as success (already stopped)', async () => {
    const http: SecretVmHttpClient = {
      async fetch() {
        return makeResponse(404);
      },
    };

    const x402 = new X402Client(makeX402Wallet());
    const client = new SecretVmClient(makeEvmWallet(), x402, 'http://localhost:3000', http);

    // Should not throw
    await client.stopVm('vm-gone');
  });

  it('stopVm falls back to POST /stop on 405', async () => {
    let callCount = 0;
    let lastUrl = '';
    let lastMethod = '';
    const http: SecretVmHttpClient = {
      async fetch(fetchUrl: string, init?: RequestInit) {
        callCount++;
        lastUrl = fetchUrl;
        lastMethod = init?.method ?? 'GET';
        if (callCount === 1) {
          return makeResponse(405);
        }
        return makeResponse(200);
      },
    };

    const x402 = new X402Client(makeX402Wallet());
    const client = new SecretVmClient(makeEvmWallet(), x402, 'http://localhost:3000', http);

    await client.stopVm('vm-legacy');
    assert.equal(callCount, 2);
    assert.equal(lastMethod, 'POST');
    assert.ok(lastUrl.includes('/api/agent/vm/vm-legacy/stop'));
  });
});
