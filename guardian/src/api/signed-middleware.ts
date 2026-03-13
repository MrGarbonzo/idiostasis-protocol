/**
 * Signed Envelope Middleware — Express middleware that unwraps and verifies
 * SignedEnvelope requests against the trust store.
 *
 * When enabled, all requests must include a SignedEnvelope in the body.
 * The middleware verifies the signature, checks nonce/timestamp, and
 * attaches the parsed payload + sender info to the request.
 */
import type { Request, Response, NextFunction } from 'express';
import type { TEESigner } from '../shared/tee-signer.js';
import type { TrustStore } from '../shared/trust-store.js';
import { verifyEnvelope, parsePayload, type SignedEnvelope } from '../shared/signed-envelope.js';

// ── Augment Express Request ──────────────────────────────────────

/** Verified envelope metadata attached to request after middleware processing. */
export interface VerifiedEnvelopeInfo {
  sender: string;
  action: string;
  timestamp: number;
  payload: unknown;
  envelope: SignedEnvelope;
}

declare global {
  namespace Express {
    interface Request {
      /** Present when the request was verified via signed envelope middleware. */
      verifiedEnvelope?: VerifiedEnvelopeInfo;
    }
  }
}

// ── Middleware Factory ───────────────────────────────────────────

export interface SignedMiddlewareOptions {
  signer: TEESigner;
  trustStore: TrustStore;
  /** If true, unsigned requests are rejected. If false, they pass through unsigned. */
  requireSigned?: boolean;
}

/**
 * Create Express middleware that verifies signed envelopes.
 *
 * When a request body contains a `version` and `signature` field (looks like
 * a SignedEnvelope), it will be verified. Otherwise:
 * - If requireSigned=true: reject with 401
 * - If requireSigned=false: pass through (for gradual migration)
 */
export function createSignedMiddleware(opts: SignedMiddlewareOptions) {
  const { signer, trustStore, requireSigned = false } = opts;

  return (req: Request, res: Response, next: NextFunction): void => {
    const body = req.body;

    // Check if body looks like a signed envelope
    if (body && typeof body === 'object' && body.version === 1 && body.signature) {
      const envelope = body as SignedEnvelope;

      // Look up sender's pubkey in trust store
      const senderPeer = trustStore.getPeer(envelope.sender);
      if (!senderPeer) {
        if (!requireSigned) {
          // Graceful pass-through: unwrap payload but skip signature verification
          req.body = parsePayload(envelope);
          next();
          return;
        }
        res.status(401).json({ error: `Unknown sender: ${envelope.sender}` });
        return;
      }

      // Verify envelope
      const result = verifyEnvelope({
        envelope,
        senderPubkeyBase64: senderPeer.ed25519PubkeyBase64,
        signer,
        nonceTracker: trustStore.getNonceTracker(),
      });

      if (!result.valid) {
        res.status(401).json({ error: `Envelope verification failed: ${result.error}` });
        return;
      }

      // Attach verified info to request
      req.verifiedEnvelope = {
        sender: envelope.sender,
        action: envelope.action,
        timestamp: envelope.timestamp,
        payload: parsePayload(envelope),
        envelope,
      };

      // Replace body with parsed payload for downstream handlers
      req.body = req.verifiedEnvelope.payload;
      next();
      return;
    }

    // Not a signed envelope
    if (requireSigned) {
      res.status(401).json({ error: 'Signed envelope required' });
      return;
    }

    // Pass through unsigned (dev/migration mode)
    next();
  };
}

/**
 * Middleware that requires a specific action type on the envelope.
 * Use after createSignedMiddleware.
 */
export function requireAction(action: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.verifiedEnvelope && req.verifiedEnvelope.action !== action) {
      res.status(400).json({
        error: `Expected action '${action}', got '${req.verifiedEnvelope.action}'`,
      });
      return;
    }
    next();
  };
}
