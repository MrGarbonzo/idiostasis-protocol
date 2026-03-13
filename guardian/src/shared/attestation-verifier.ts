/**
 * Attestation Verifier — verifies SecretVM PCCS attestation quotes.
 *
 * In production: sends the attestation quote to the PCCS service for parsing
 * and verification, extracts the ed25519 public key from the report data,
 * and validates code measurements.
 *
 * In development: accepts all attestations with synthetic validation.
 */
import type { TEESigner } from './tee-signer.js';
import type { TrustStore, TrustedPeer } from './trust-store.js';
import { formatAttestationVerified, formatAttestationRejected } from './telegram-protocol.js';

// ── Types ────────────────────────────────────────────────────────

export interface AttestationRequest {
  /** Sender's ed25519 public key (base64). */
  ed25519Pubkey: string;
  /** Raw attestation quote from SecretVM (base64 or hex). */
  attestationQuote: string;
  /** Container-generated X25519 public key (base64). */
  x25519Pubkey: string;
  /** ed25519 signature over the X25519 public key (base64). */
  x25519Signature: string;
  /** Sender's node ID. */
  senderId: string;
  /** Sender's endpoint URL (optional). */
  endpoint?: string;
  /** Whether sender is a sentry node (optional). */
  isSentry?: boolean;
}

export interface AttestationVerifyResult {
  valid: boolean;
  /** Peer ID that was verified. */
  peerId?: string;
  error?: string;
}

export interface PCCSQuoteReport {
  /** Whether PCCS considers the quote valid. */
  valid: boolean;
  /** ed25519 public key extracted from report data (hex or base64). */
  reportDataPubkey?: string;
  /**
   * Container image measurement (RTMR3).
   * Measures the root filesystem + docker-compose.yaml — this is the GHCR
   * image identity and the value that approved measurements should match.
   */
  containerMeasurement?: string;
  /** TD/enclave measurement (MRTD / MRENCLAVE) — firmware identity. */
  tdMeasurement?: string;
  /** Full parsed report (for debugging). */
  rawReport?: unknown;
  error?: string;
}

// ── PCCS Client ──────────────────────────────────────────────────

const PCCS_ENDPOINT = process.env.PCCS_ENDPOINT ?? 'https://pccs.scrtlabs.com/dcap-tools/quote-parse';

/**
 * Parse and verify an attestation quote via PCCS.
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
    // PCCS may nest fields under report.quote — unwrap if present
    const quoteData = (report.quote ?? report) as Record<string, unknown>;

    // Extract report data (first 32 bytes typically contain the ed25519 pubkey)
    const reportData = quoteData.report_data as string | undefined;
    let reportDataPubkey: string | undefined;

    if (reportData) {
      // Report data is hex-encoded; first 64 hex chars = 32 bytes = ed25519 pubkey
      reportDataPubkey = reportData.substring(0, 64);
    }

    // RTMR3 measures the container rootfs + docker-compose.yaml (= GHCR image identity).
    // MRTD/MRENCLAVE measures the firmware/TD (same for all VMs with same firmware).
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

// ── Inline Per-Interaction Attestation ────────────────────────────

/**
 * Verify an attestation quote inline (without modifying trust store).
 * Used for per-interaction attestation on DB sync and recovery requests.
 * Proves the sender is *still* running in a valid TEE at the moment of the request.
 */
export async function verifyInlineAttestation(
  attestationQuote: string,
  expectedPubkeyBase64: string,
  approvedMeasurements?: Set<string>,
): Promise<{ valid: boolean; error?: string }> {
  const pccs = await verifyQuoteViaPCCS(attestationQuote);
  if (!pccs.valid) return { valid: false, error: pccs.error };

  // Check pubkey binding: report_data pubkey must match sender's declared key
  if (pccs.reportDataPubkey) {
    const expectedHex = Buffer.from(expectedPubkeyBase64, 'base64').toString('hex');
    if (pccs.reportDataPubkey !== expectedHex) {
      return { valid: false, error: 'Attestation pubkey mismatch — TEE identity changed' };
    }
  }

  // Check container image measurement (RTMR3) against approved list
  if (approvedMeasurements && approvedMeasurements.size > 0) {
    const measurement = pccs.containerMeasurement;
    if (!measurement) {
      return { valid: false, error: 'PCCS did not return container measurement (RTMR3)' };
    }
    if (!approvedMeasurements.has(measurement)) {
      return { valid: false, error: `Container measurement not approved: ${measurement}` };
    }
  }

  return { valid: true };
}

// ── Attestation Verifier ─────────────────────────────────────────

export interface AttestationVerifierOptions {
  /** If true, skip PCCS verification and accept all attestations. */
  devMode?: boolean;
  /** Set of approved RTMR3 container image hashes (empty = accept all). */
  approvedMeasurements?: Set<string>;
  /** Optional callback for trust events. */
  onEvent?: (msg: string) => void;
}

export class AttestationVerifier {
  private devMode: boolean;
  private approvedMeasurements: Set<string>;
  private onEvent?: (msg: string) => void;

  constructor(opts: AttestationVerifierOptions = {}) {
    this.devMode = opts.devMode ?? (process.env.NODE_ENV !== 'production');
    this.approvedMeasurements = opts.approvedMeasurements ?? new Set();
    this.onEvent = opts.onEvent;
  }

  /**
   * Verify an attestation request and add the peer to the trust store if valid.
   *
   * Steps:
   * 1. Verify attestation quote via PCCS (production) or accept (dev)
   * 2. Extract ed25519 pubkey from attestation report data
   * 3. Compare with declared pubkey
   * 4. Verify X25519 signature (proves X25519 key belongs to same TEE)
   * 5. Add peer to trust store
   */
  async verifyAndTrust(
    request: AttestationRequest,
    signer: TEESigner,
    trustStore: TrustStore,
  ): Promise<AttestationVerifyResult> {
    const result = this.devMode
      ? this.verifyDev(request, signer, trustStore)
      : await this.verifyProduction(request, signer, trustStore);

    if (result.valid) {
      this.onEvent?.(formatAttestationVerified({
        peerId: request.senderId,
        pubkey: request.ed25519Pubkey.substring(0, 8),
        isSentry: request.isSentry ?? false,
      }));
    } else {
      this.onEvent?.(formatAttestationRejected({
        peerId: request.senderId,
        reason: result.error ?? 'unknown',
      }));
    }

    return result;
  }

  private async verifyProduction(
    request: AttestationRequest,
    signer: TEESigner,
    trustStore: TrustStore,
  ): Promise<AttestationVerifyResult> {
    // 1. Verify attestation quote via PCCS
    const pccsResult = await verifyQuoteViaPCCS(request.attestationQuote);
    if (!pccsResult.valid) {
      return { valid: false, error: `Attestation quote invalid: ${pccsResult.error}` };
    }

    // 2. Extract ed25519 pubkey from report data and compare with declared
    if (pccsResult.reportDataPubkey) {
      const declaredPubkeyHex = Buffer.from(request.ed25519Pubkey, 'base64').toString('hex');
      if (pccsResult.reportDataPubkey !== declaredPubkeyHex) {
        return {
          valid: false,
          error: 'ed25519 pubkey does not match attestation report data',
        };
      }
    }

    // 3. Check container image measurement (RTMR3) against approved list
    if (this.approvedMeasurements.size > 0) {
      const measurement = pccsResult.containerMeasurement;
      if (!measurement) {
        return {
          valid: false,
          error: 'PCCS did not return container measurement (RTMR3)',
        };
      }
      if (!this.approvedMeasurements.has(measurement)) {
        return {
          valid: false,
          error: `Container measurement not approved: ${measurement}`,
        };
      }
    }

    // 4. Verify X25519 signature
    return this.verifyX25519AndTrust(request, signer, trustStore);
  }

  private verifyDev(
    request: AttestationRequest,
    signer: TEESigner,
    trustStore: TrustStore,
  ): AttestationVerifyResult {
    // In dev mode, skip PCCS but still verify X25519 signature
    return this.verifyX25519AndTrust(request, signer, trustStore);
  }

  private verifyX25519AndTrust(
    request: AttestationRequest,
    signer: TEESigner,
    trustStore: TrustStore,
  ): AttestationVerifyResult {
    // Verify that the X25519 pubkey was signed by the declared ed25519 key.
    // Note: SecretVM signs the base64 payload string, not decoded bytes.
    const sigValid = signer.verify(
      request.x25519Pubkey,
      request.x25519Signature,
      request.ed25519Pubkey,
    );

    if (!sigValid) {
      return { valid: false, error: 'X25519 pubkey signature invalid' };
    }

    // Add to trust store
    const now = Date.now();
    const peer: TrustedPeer = {
      id: request.senderId,
      ed25519PubkeyBase64: request.ed25519Pubkey,
      x25519PubkeyBase64: request.x25519Pubkey,
      attestedAt: now,
      lastVerified: now,
      attestationQuote: request.attestationQuote,
      endpoint: request.endpoint,
      isSentry: request.isSentry,
    };

    trustStore.addPeer(peer);

    return { valid: true, peerId: request.senderId };
  }

  /** Add approved code measurement. */
  approveMeasurement(hash: string): void {
    this.approvedMeasurements.add(hash);
  }

  /** Remove approved code measurement. */
  revokeMeasurement(hash: string): void {
    this.approvedMeasurements.delete(hash);
  }
}
