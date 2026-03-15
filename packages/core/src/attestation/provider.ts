import type { AttestationProvider, AttestationResult, SelfReport } from '../interfaces.js';
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

  /**
   * Fetch structured attestation report from self.html endpoint.
   * Parses RTMR fields using multi-strategy extraction.
   * Never throws — returns partial SelfReport with what was found.
   */
  async fetchSelfReport(domain: string): Promise<SelfReport> {
    const url = `https://${domain}:29343/self.html`;
    let html: string;

    try {
      const https = await import('node:https');
      html = await new Promise<string>((resolve, reject) => {
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
        req.on('timeout', () => { req.destroy(new Error('self.html request timed out')); });
      });
    } catch (err) {
      console.warn(`[attestation] fetchSelfReport failed for ${domain}: ${err}`);
      return { raw: undefined };
    }

    return parseSelfReport(html);
  }
}

/**
 * Parse a self.html response into a SelfReport using multi-strategy extraction.
 * Exported for testing.
 */
export function parseSelfReport(html: string): SelfReport {
  const report: SelfReport = { raw: html };

  // Strategy 1: JSON embedded in <pre> or <script> tags
  const jsonMatch = html.match(/<(?:pre|script)[^>]*>([\s\S]*?)<\/(?:pre|script)>/i);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      if (typeof parsed === 'object' && parsed !== null) {
        const obj = parsed as Record<string, unknown>;
        if (obj.rtmr0) report.rtmr0 = String(obj.rtmr0);
        if (obj.rtmr1) report.rtmr1 = String(obj.rtmr1);
        if (obj.rtmr2) report.rtmr2 = String(obj.rtmr2);
        if (obj.rtmr3) report.rtmr3 = String(obj.rtmr3);
        if (obj.reportData || obj.report_data) report.reportData = String(obj.reportData ?? obj.report_data);
        if (obj.mrtd) report.mrtd = String(obj.mrtd);
        if (report.rtmr3) {
          console.log('[attestation] self.html: extracted RTMR3 via JSON strategy');
          return report;
        }
      }
    } catch { /* not JSON, try next strategy */ }
  }

  // Strategy 2: Table rows — look for td containing RTMR field names
  const rtmrFields = ['rtmr0', 'rtmr1', 'rtmr2', 'rtmr3', 'mrtd'] as const;
  for (const field of rtmrFields) {
    const tablePattern = new RegExp(
      `<td[^>]*>\\s*${field}\\s*</td>\\s*<td[^>]*>\\s*([0-9a-fA-F]{64,})\\s*</td>`,
      'i',
    );
    const match = html.match(tablePattern);
    if (match) {
      (report as Record<string, unknown>)[field] = match[1];
    }
  }
  // reportData from table
  const reportDataTable = html.match(
    /<td[^>]*>\s*report[_\s]?data\s*<\/td>\s*<td[^>]*>\s*([0-9a-fA-F]{64,})\s*<\/td>/i,
  );
  if (reportDataTable) report.reportData = reportDataTable[1];

  if (report.rtmr3) {
    console.log('[attestation] self.html: extracted RTMR3 via table strategy');
    return report;
  }

  // Strategy 3: Regex patterns — key-value pairs
  for (const field of rtmrFields) {
    const pattern = new RegExp(`${field}[:\\s]+([0-9a-fA-F]{64,})`, 'i');
    const match = html.match(pattern);
    if (match && !(report as Record<string, unknown>)[field]) {
      (report as Record<string, unknown>)[field] = match[1];
    }
  }
  const reportDataRegex = html.match(/report[_\s]?data[:\s]+([0-9a-fA-F]{64,})/i);
  if (reportDataRegex && !report.reportData) report.reportData = reportDataRegex[1];

  if (report.rtmr3) {
    console.log('[attestation] self.html: extracted RTMR3 via regex strategy');
    return report;
  }

  // Strategy 4: return raw HTML for manual inspection
  console.warn('[attestation] self.html: no RTMR3 found — returning raw HTML');
  return report;
}
