import { createHash } from 'node:crypto';
import type { X402Client } from './client.js';

export interface EvmSigningWallet {
  address: string;
  signMessage(hash: string): Promise<string>;
}

export interface CreateVmParams {
  name: string;
  vmTypeId: string;
  dockerComposeYaml: string;
  erc8004Registration?: object;
  cloudflareApiKey?: string;
  fsPersistence?: boolean;
  environment?: string;
}

export interface VmStatus {
  id: string;
  name: string;
  status: string;
  vmDomain: string;
  vmId: string;
  vmUid: string;
}

export interface AgentRequestHeaders {
  'x-agent-address': string;
  'x-agent-signature': string;
  'x-agent-timestamp': string;
}

/**
 * Interface for HTTP calls — injectable for testing.
 */
export interface SecretVmHttpClient {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

const defaultSecretVmHttp: SecretVmHttpClient = {
  fetch: (url, init) => globalThis.fetch(url, init),
};

/**
 * SecretVM REST API client.
 * Implements the full autonomous VM management flow from spec Section 7.
 * Base URL: https://secretai.scrtlabs.com (configurable via SECRETVM_BASE_URL)
 */
export class SecretVmClient {
  private readonly wallet: EvmSigningWallet;
  private readonly x402Client: X402Client;
  private readonly baseUrl: string;
  private readonly http: SecretVmHttpClient;

  constructor(
    wallet: EvmSigningWallet,
    x402Client: X402Client,
    baseUrl?: string,
    http?: SecretVmHttpClient,
  ) {
    this.wallet = wallet;
    this.x402Client = x402Client;
    this.baseUrl = baseUrl ?? 'https://secretai.scrtlabs.com';
    this.http = http ?? defaultSecretVmHttp;
  }

  /**
   * Build authentication headers per spec Section 7:
   * - timestamp = Date.now().toString()
   * - payload = `${method}${path}${body}${timestamp}`
   * - requestHash = SHA-256 hex of payload
   * - signature = wallet.signMessage(requestHash)
   */
  async buildHeaders(method: string, path: string, body: string): Promise<AgentRequestHeaders> {
    const timestamp = String(Date.now());
    const payload = `${method}${path}${body}${timestamp}`;
    const requestHash = sha256hex(payload);
    const signature = await this.wallet.signMessage(requestHash);
    return {
      'x-agent-address': this.wallet.address,
      'x-agent-signature': signature,
      'x-agent-timestamp': timestamp,
    };
  }

  async getBalance(): Promise<number> {
    const path = '/api/agent/balance';
    const headers = await this.buildHeaders('GET', path, '');
    const res = await this.http.fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: headers as unknown as Record<string, string>,
    });
    if (!res.ok) throw new Error(`getBalance failed: ${res.status}`);
    const data = await res.json() as { balance: string };
    return parseInt(data.balance, 10);
  }

  async addFunds(amountUsdc: number): Promise<void> {
    const path = '/api/agent/add-funds';
    const body = stableStringify({ amount_usdc: String(amountUsdc) });
    const headers = await this.buildHeaders('POST', path, body);

    let res = await this.http.fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      body,
      headers: {
        ...headers as unknown as Record<string, string>,
        'Content-Type': 'application/json',
      },
    });

    if (res.status === 402) {
      // x402 payment required — use x402Client to pay
      await this.x402Client.fetchWithPayment(`${this.baseUrl}${path}`);
      // Retry with fresh headers after payment
      const retryHeaders = await this.buildHeaders('POST', path, body);
      res = await this.http.fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        body,
        headers: {
          ...retryHeaders as unknown as Record<string, string>,
          'Content-Type': 'application/json',
        },
      });
    }

    if (!res.ok) throw new Error(`addFunds failed: ${await res.text()}`);
  }

  async createVm(params: CreateVmParams): Promise<VmStatus> {
    const path = '/api/vm/create';
    const composeBytes = new TextEncoder().encode(params.dockerComposeYaml);

    // CRITICAL: signing uses the stable JSON representation, NOT the raw multipart body.
    const fields: Record<string, string> = {
      name: params.name,
      vmTypeId: params.vmTypeId,
    };
    if (params.erc8004Registration) {
      fields.eip8004_registration = JSON.stringify(params.erc8004Registration);
    }
    if (params.cloudflareApiKey) {
      fields.cloudflareApiKey = params.cloudflareApiKey;
    }
    if (params.fsPersistence !== undefined) {
      fields.fs_persistence = String(params.fsPersistence);
    }
    if (params.environment) {
      fields.environment = params.environment;
    }

    const signingPayload = stableStringify({
      fields,
      file: {
        fieldname: 'dockercompose',
        mimetype: 'application/x-yaml',
        originalname: 'docker-compose.yml',
        sha256: sha256hex(composeBytes),
        size: composeBytes.length,
      },
    });

    const headers = await this.buildHeaders('POST', path, signingPayload);

    // Build multipart form data
    const formBody = buildMultipartForm(fields, composeBytes);

    const res = await this.http.fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      body: formBody.body,
      headers: {
        ...headers as unknown as Record<string, string>,
        'Content-Type': formBody.contentType,
      },
    });

    if (res.status === 402) {
      // Insufficient balance — top up then retry once
      await this.addFunds(1);
      return this.createVm(params);
    }

    if (!res.ok) throw new Error(`createVm failed: ${await res.text()}`);
    return await res.json() as VmStatus;
  }

  /**
   * Get the signing payload for createVm.
   * Exposed for testing to verify the critical signing behavior.
   */
  getCreateVmSigningPayload(params: CreateVmParams): string {
    const composeBytes = new TextEncoder().encode(params.dockerComposeYaml);

    const fields: Record<string, string> = {
      name: params.name,
      vmTypeId: params.vmTypeId,
    };
    if (params.erc8004Registration) {
      fields.eip8004_registration = JSON.stringify(params.erc8004Registration);
    }
    if (params.cloudflareApiKey) {
      fields.cloudflareApiKey = params.cloudflareApiKey;
    }
    if (params.fsPersistence !== undefined) {
      fields.fs_persistence = String(params.fsPersistence);
    }
    if (params.environment) {
      fields.environment = params.environment;
    }

    return stableStringify({
      fields,
      file: {
        fieldname: 'dockercompose',
        mimetype: 'application/x-yaml',
        originalname: 'docker-compose.yml',
        sha256: sha256hex(composeBytes),
        size: composeBytes.length,
      },
    });
  }

  async getVmStatus(vmId: string): Promise<VmStatus> {
    const path = `/api/agent/vm/${vmId}`;
    const headers = await this.buildHeaders('GET', path, '');
    const res = await this.http.fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: headers as unknown as Record<string, string>,
    });

    if (res.status === 404) {
      return {
        id: vmId,
        name: '',
        status: 'not_found',
        vmDomain: '',
        vmId,
        vmUid: '',
      };
    }

    if (!res.ok) throw new Error(`getVmStatus failed: ${res.status}`);
    return await res.json() as VmStatus;
  }

  async pollUntilRunning(
    vmId: string,
    intervalMs: number = 15_000,
    timeoutMs: number = 600_000,
  ): Promise<VmStatus> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const status = await this.getVmStatus(vmId);
      if (status.status === 'running') return status;
      await new Promise(r => setTimeout(r, intervalMs));
    }

    throw new Error(`pollUntilRunning: timeout after ${timeoutMs}ms for VM ${vmId}`);
  }

  async stopVm(_vmId: string): Promise<void> {
    // TODO: Confirm the stop/delete endpoint from SecretVM docs when available.
    throw new NotImplementedError('stopVm: endpoint not confirmed');
  }
}

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

// --- Utility functions ---

/**
 * JSON.stringify with recursively sorted keys.
 * Self-contained duplicate — does not import from @idiostasis/core.
 * Must match the server's algorithm exactly.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, sortedReplacer);
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

function sha256hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

function buildMultipartForm(
  fields: Record<string, string>,
  composeBytes: Uint8Array,
): { body: string; contentType: string } {
  const boundary = '----FormBoundary' + Date.now().toString(36);
  let body = '';

  for (const [key, value] of Object.entries(fields)) {
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="${key}"\r\n\r\n`;
    body += `${value}\r\n`;
  }

  body += `--${boundary}\r\n`;
  body += `Content-Disposition: form-data; name="dockercompose"; filename="docker-compose.yml"\r\n`;
  body += `Content-Type: application/x-yaml\r\n\r\n`;
  body += new TextDecoder().decode(composeBytes) + '\r\n';
  body += `--${boundary}--\r\n`;

  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
