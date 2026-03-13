/**
 * Express server for the Guardian Network API.
 */
import express from 'express';
import { createRouter } from './routes.js';
import { createSentryRouter } from './sentry-routes.js';
import { createSignedMiddleware } from './signed-middleware.js';
import type { ApiDeps } from './routes.js';
import type { SentryApiDeps } from './sentry-routes.js';
import type { TEESigner } from '../shared/tee-signer.js';
import type { TrustStore } from '../shared/trust-store.js';
import type { AttestationVerifier, AttestationRequest } from '../shared/attestation-verifier.js';
import { wrapVaultKey } from '../shared/vault.js';
import type { DBSnapshotReceiver } from '../guardian/db-sync.js';
import type { SignedEnvelope } from '../shared/signed-envelope.js';

export interface SignedApiDeps {
  signer: TEESigner;
  trustStore: TrustStore;
  /** If true, reject unsigned requests. Default false (gradual migration). */
  requireSigned?: boolean;
}

export interface AttestationApiDeps {
  signer: TEESigner;
  trustStore: TrustStore;
  attestationVerifier: AttestationVerifier;
  vaultKey: Buffer;
  onEvent?: (msg: string) => void;
}

export interface DBSyncDeps {
  snapshotReceiver: DBSnapshotReceiver;
  onEvent?: (msg: string) => void;
}

export interface ServerDeps {
  guardian: ApiDeps;
  sentry?: SentryApiDeps;
  /** Dynamic guard: returns true if this node is currently a sentry. */
  sentryGuard?: () => boolean;
  /** If provided, enables signed envelope verification middleware. */
  signed?: SignedApiDeps;
  /** If provided, enables the POST /api/attestation route. */
  attestation?: AttestationApiDeps;
  /** If provided, enables the POST /api/db/snapshot route. */
  dbSync?: DBSyncDeps;
}

export function createServer(deps: ServerDeps): express.Application {
  const app = express();

  app.use(express.json({ limit: '50mb' }));

  // Health ping (no auth needed, never signed)
  app.get('/ping', (_req, res) => {
    res.json({ status: 'ok', guardian: deps.guardian.guardianAddress, timestamp: Date.now() });
  });

  // Attestation route — must come BEFORE signed middleware since the sender
  // isn't trusted yet and can't pass envelope verification.
  if (deps.attestation) {
    const att = deps.attestation;

    app.post('/api/attestation', async (req, res) => {
      try {
        // Support both raw AttestationRequest and envelope-wrapped
        let request: AttestationRequest;
        const body = req.body;

        if (body.version === 1 && body.payload) {
          // Envelope-wrapped: extract payload
          const payload = typeof body.payload === 'string' ? JSON.parse(body.payload) : body.payload;
          request = payload as AttestationRequest;
        } else {
          request = body as AttestationRequest;
        }

        if (!request.ed25519Pubkey || !request.x25519Pubkey || !request.senderId) {
          res.status(400).json({ success: false, error: 'Missing required fields: ed25519Pubkey, x25519Pubkey, senderId' });
          return;
        }

        const result = await att.attestationVerifier.verifyAndTrust(request, att.signer, att.trustStore);

        if (!result.valid) {
          res.status(403).json({ success: false, error: result.error ?? 'Attestation verification failed' });
          return;
        }

        // Wrap vault key for the attested peer
        const wrappedVaultKey = await wrapVaultKey(att.vaultKey, att.signer, request.x25519Pubkey);
        att.onEvent?.(`[VAULT:KEY_SENT] Vault key sent to ${request.senderId}`);

        res.json({ success: true, wrappedVaultKey });
      } catch (err) {
        console.error('[Attestation] Error:', err);
        res.status(500).json({ success: false, error: 'Internal attestation error' });
      }
    });
  }

  // DB snapshot route — before signed middleware since receiver does its own
  // envelope verification via the trust store.
  if (deps.dbSync) {
    const sync = deps.dbSync;
    app.post('/api/db/snapshot', async (req, res) => {
      try {
        const envelope = req.body as SignedEnvelope;
        if (!envelope.version || !envelope.sender || !envelope.signature) {
          res.status(400).json({ accepted: false, error: 'Invalid envelope' });
          return;
        }
        const result = await sync.snapshotReceiver.receiveSnapshot(envelope, { decryptAndVerify: false });
        if (!result.accepted) {
          res.status(400).json({ accepted: false, error: result.error });
          return;
        }
        sync.onEvent?.(`[DB:SYNC_RECEIVED] seq=${result.sequenceNum} from ${envelope.sender}`);
        res.json({ accepted: true, sequenceNum: result.sequenceNum });
      } catch (err) {
        console.error('[DB Sync] Snapshot receive error:', err);
        res.status(500).json({ accepted: false, error: 'Internal error' });
      }
    });
  }

  // Apply signed envelope middleware if configured
  if (deps.signed) {
    app.use('/api', createSignedMiddleware({
      signer: deps.signed.signer,
      trustStore: deps.signed.trustStore,
      requireSigned: deps.signed.requireSigned,
    }));
  }

  // Mount guardian API routes under /api
  app.use('/api', createRouter(deps.guardian));

  // Mount sentry governance routes under /api/sentry
  if (deps.sentry) {
    // Dynamic sentry guard: returns 403 if this node is not currently a sentry
    if (deps.sentryGuard) {
      const guard = deps.sentryGuard;
      app.use('/api/sentry', (req, res, next) => {
        if (!guard()) {
          res.status(403).json({ error: 'This node is not currently a sentry' });
          return;
        }
        next();
      });
    }
    app.use('/api/sentry', createSentryRouter(deps.sentry));
  }

  return app;
}
