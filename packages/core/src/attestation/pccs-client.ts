import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AttestationResult } from '../interfaces.js';

/**
 * Function type for making PCCS POST requests.
 * Accepts endpoint URL and JSON body string, returns parsed response.
 * Injectable for testing.
 */
export type PccsFetcher = (url: string, body: string) => Promise<Record<string, unknown>>;

/**
 * Default PCCS fetcher using node:https with per-request TLS override.
 * NEVER sets NODE_TLS_REJECT_UNAUTHORIZED globally — known race condition.
 */
const defaultFetcher: PccsFetcher = async (url: string, body: string) => {
  // Dynamic import to avoid top-level side effects in tests
  const https = await import('node:https');
  const parsed = new URL(url);

  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        rejectUnauthorized: false,
        timeout: 10_000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as Record<string, unknown>);
          } catch {
            reject(new Error(`PCCS returned invalid JSON: ${data.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('PCCS request timed out')); });
    req.write(body);
    req.end();
  });
};

/**
 * Verify attestation quote against PCCS endpoints (Decision 4).
 * Tries endpoints in order. Hard failure only if all exhausted.
 * Always checks both 'rtmr3' and 'rtmr_3' field names.
 */
export async function verifyWithPccs(
  quote: string,
  endpoints: string[],
  fetcher: PccsFetcher = defaultFetcher,
): Promise<AttestationResult> {
  const body = JSON.stringify({ quote });

  for (const endpoint of endpoints) {
    try {
      const data = await fetcher(endpoint, body);

      const quoteObj = (data.quote ?? data) as Record<string, unknown>;
      const rtmr3 = (quoteObj.rtmr3 ?? quoteObj.rtmr_3 ?? data.rtmr3 ?? data.rtmr_3) as string | undefined;
      if (!rtmr3) throw new Error('PCCS response missing rtmr3/rtmr_3 field');

      const statusObj = (data.status ?? data) as Record<string, unknown>;
      const tcbStatus = (statusObj.result ?? statusObj.tcb_status ?? statusObj.tcbStatus ?? 'unknown') as string;
      return { rtmr3, valid: true, tcbStatus };
    } catch (err) {
      console.warn(`PCCS endpoint ${endpoint} failed:`, err);
      continue;
    }
  }

  throw new Error('All PCCS endpoints exhausted');
}

/**
 * Read local RTMR3 from TEE attestation filesystem.
 * Priority:
 *   1. /dev/attestation/rtmr3
 *   2. /dev/attestation/mr_enclave
 *   3. Dev fallback: SHA256('idiostasis-dev') as hex
 */
export async function readLocalRtmr3(): Promise<string> {
  const paths = [
    '/dev/attestation/rtmr3',
    '/dev/attestation/mr_enclave',
  ];

  for (const path of paths) {
    try {
      const content = await readFile(path, 'utf-8');
      const trimmed = content.trim();
      if (trimmed) {
        console.log(`[attestation] read local RTMR3 from ${path}`);
        return trimmed;
      }
    } catch {
      continue;
    }
  }

  const devHash = createHash('sha256').update('idiostasis-dev').digest('hex');
  console.warn('[attestation] using dev RTMR3 fallback:', devHash);
  return devHash;
}
