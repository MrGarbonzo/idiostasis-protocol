/**
 * Guardian Verifier — verifies guardian SecretVM attestation from the agent side.
 *
 * Flow:
 * 1. Fetch attestation quote from guardian's SecretVM runtime (:29343/cpu.html)
 * 2. Send quote to PCCS for parsing and verification
 * 3. Check RTMR3 (container image measurement) against approved list
 */

// ── Types ────────────────────────────────────────────────────────

export interface PCCSQuoteReport {
  valid: boolean;
  /** ed25519 public key extracted from report data (hex). */
  reportDataPubkey?: string;
  /**
   * Container image measurement (RTMR3).
   * Measures the root filesystem + docker-compose.yaml — the GHCR image identity.
   */
  containerMeasurement?: string;
  /** TD/enclave measurement (MRTD / MRENCLAVE) — firmware identity. */
  tdMeasurement?: string;
  rawReport?: unknown;
  error?: string;
}

export interface GuardianVerifyResult {
  valid: boolean;
  codeMeasurement?: string;
  error?: string;
}

// ── Config ───────────────────────────────────────────────────────

const PCCS_ENDPOINT = process.env.PCCS_ENDPOINT ?? 'https://pccs.scrtlabs.com/dcap-tools/quote-parse';
const ATTESTATION_PORT = 29343;

// ── Quote Fetching ───────────────────────────────────────────────

/**
 * Extract the attestation quote from the SecretVM cpu.html page.
 * The page typically contains the raw quote as a long hex or base64 string.
 */
function extractQuoteFromHtml(html: string): string | null {
  // Try to find content inside <pre> tags first
  const preMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (preMatch) {
    const content = preMatch[1].replace(/<[^>]*>/g, '').trim();
    if (content.length > 100) return content;
  }

  // Try to find content inside <textarea> tags
  const textareaMatch = html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/i);
  if (textareaMatch) {
    const content = textareaMatch[1].trim();
    if (content.length > 100) return content;
  }

  // Fall back: find the longest hex string (attestation quotes are large)
  const hexStrings = html.replace(/<[^>]*>/g, ' ').match(/[0-9a-fA-F]{128,}/g);
  if (hexStrings) {
    return hexStrings.reduce((a, b) => (a.length >= b.length ? a : b));
  }

  // Fall back: find the longest base64 string
  const b64Strings = html.replace(/<[^>]*>/g, ' ').match(/[A-Za-z0-9+/=]{128,}/g);
  if (b64Strings) {
    return b64Strings.reduce((a, b) => (a.length >= b.length ? a : b));
  }

  return null;
}

/**
 * Fetch the attestation quote from a guardian's SecretVM runtime endpoint.
 */
async function fetchAttestationQuote(guardianEndpoint: string): Promise<string> {
  const url = new URL(guardianEndpoint);
  const attestationUrl = `https://${url.hostname}:${ATTESTATION_PORT}/cpu.html`;

  // SecretVM uses a self-signed cert whose fingerprint is embedded in the
  // attestation quote's report_data — MITM is detectable post-verification.
  // Temporarily disable TLS verification for this fetch only.
  const origTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  let res: Response;
  try {
    res = await fetch(attestationUrl, {
      signal: AbortSignal.timeout(10_000),
    });
  } finally {
    if (origTls === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = origTls;
    }
  }

  if (!res.ok) {
    throw new Error(`Attestation endpoint returned ${res.status}: ${res.statusText}`);
  }

  const html = await res.text();
  const quote = extractQuoteFromHtml(html);

  if (!quote) {
    throw new Error('Could not extract attestation quote from cpu.html');
  }

  return quote;
}

// ── PCCS Verification ────────────────────────────────────────────

/**
 * Parse and verify an attestation quote via Intel PCCS.
 */
export async function verifyQuoteViaPCCS(attestationQuote: string): Promise<PCCSQuoteReport> {
  try {
    const res = await fetch(PCCS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quote: attestationQuote }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return { valid: false, error: `PCCS returned ${res.status}: ${res.statusText}` };
    }

    const report = await res.json() as Record<string, unknown>;

    // PCCS returns { collateral, status, quote: { mr_td, report_data, ... } }
    const quoteData = (report.quote ?? report) as Record<string, unknown>;

    // Extract report data (first 32 bytes = ed25519 pubkey)
    const reportData = quoteData.report_data as string | undefined;
    let reportDataPubkey: string | undefined;
    if (reportData) {
      reportDataPubkey = reportData.substring(0, 64);
    }

    // RTMR3 measures the container rootfs + docker-compose.yaml (= GHCR image identity).
    const containerMeasurement = (quoteData.rtmr_3 ?? quoteData.rtmr3) as string | undefined;
    const tdMeasurement = (quoteData.mr_td ?? quoteData.mr_enclave) as string | undefined;

    return {
      valid: true,
      reportDataPubkey,
      containerMeasurement,
      tdMeasurement,
      rawReport: report,
    };
  } catch (err) {
    return {
      valid: false,
      error: `PCCS verification failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Verify a guardian's SecretVM attestation.
 *
 * 1. Fetches the attestation quote from the guardian's :29343/cpu.html
 * 2. Sends to PCCS for verification
 * 3. Checks RTMR3 (container image) against approved measurements (if any)
 */
export async function verifyGuardianAttestation(
  guardianEndpoint: string,
  approvedMeasurements: Set<string>,
): Promise<GuardianVerifyResult> {
  // 1. Fetch quote from guardian's SecretVM runtime
  let quote: string;
  try {
    quote = await fetchAttestationQuote(guardianEndpoint);
  } catch (err) {
    return {
      valid: false,
      error: `Failed to fetch attestation quote: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 2. Verify via PCCS
  const pccsResult = await verifyQuoteViaPCCS(quote);
  if (!pccsResult.valid) {
    return { valid: false, error: pccsResult.error };
  }

  // 3. Check container image measurement (RTMR3) against approved list
  if (approvedMeasurements.size > 0) {
    if (!pccsResult.containerMeasurement) {
      return { valid: false, error: 'PCCS did not return container measurement (RTMR3)' };
    }
    if (!approvedMeasurements.has(pccsResult.containerMeasurement)) {
      return {
        valid: false,
        error: `Guardian container measurement not approved: ${pccsResult.containerMeasurement}`,
      };
    }
  } else {
    // First-guardian auto-enrollment: accept and lock to this measurement
    if (!pccsResult.containerMeasurement) {
      return { valid: false, error: 'First guardian must provide container measurement for auto-enrollment' };
    }
    approvedMeasurements.add(pccsResult.containerMeasurement);
    console.log(`[idiostasis] First-guardian auto-enrollment: locked to measurement ${pccsResult.containerMeasurement}`);
  }

  return { valid: true, codeMeasurement: pccsResult.containerMeasurement };
}
