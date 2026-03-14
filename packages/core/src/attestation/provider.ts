import type { AttestationProvider, AttestationResult } from '../interfaces.js';
import { extractQuoteFromHtml } from './cpu-html.js';
import { verifyWithPccs } from './pccs-client.js';
import { DEFAULT_PCCS_ENDPOINTS } from '../config.js';

/**
 * Default AttestationProvider implementation using SecretLabs PCCS (Decision 4).
 * Swappable — the AttestationProvider interface is the contract.
 */
export class SecretLabsAttestationProvider implements AttestationProvider {
  private readonly pccsEndpoints: string[];

  constructor(pccsEndpoints?: string[]) {
    this.pccsEndpoints = pccsEndpoints ?? [...DEFAULT_PCCS_ENDPOINTS];
  }

  /**
   * Fetch TDX quote from cpu.html endpoint.
   * Uses per-request TLS agent — never global NODE_TLS_REJECT_UNAUTHORIZED.
   */
  async fetchQuote(domain: string): Promise<string> {
    const url = `https://${domain}:29343/cpu.html`;
    const https = await import('node:https');

    const html = await new Promise<string>((resolve, reject) => {
      const req = https.get(
        url,
        { rejectUnauthorized: false, timeout: 10_000 },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk; });
          res.on('end', () => resolve(data));
        },
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('cpu.html request timed out')); });
    });

    return extractQuoteFromHtml(html, (msg) => console.debug(msg));
  }

  /** Verify quote against PCCS, return AttestationResult. */
  async verifyQuote(quote: string): Promise<AttestationResult> {
    return verifyWithPccs(quote, this.pccsEndpoints);
  }
}
