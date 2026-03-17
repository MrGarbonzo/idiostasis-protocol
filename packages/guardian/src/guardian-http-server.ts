import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { PingEnvelope, DbSnapshot, WrappedKey } from '@idiostasis/core';
import type { LivenessMonitor } from './liveness/monitor.js';
import type { AdmissionPayload, OnAdmissionReceived } from './http-server.js';

export interface VaultKeyUpdatePayload {
  wrappedKey: WrappedKey;
  snapshot: DbSnapshot;
  primaryX25519PublicKey: string; // base64-encoded
}

export type OnVaultKeyUpdate = (payload: VaultKeyUpdatePayload) => Promise<void>;

type AsyncHandler = (req: Request, res: Response) => Promise<void>;

function asyncWrap(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

export class GuardianHttpServer {
  private readonly app: ReturnType<typeof express>;
  private server: ReturnType<ReturnType<typeof express>['listen']> | null = null;

  constructor(
    private readonly port: number,
    private readonly livenessMonitor: LivenessMonitor,
    private readonly onAdmission: OnAdmissionReceived,
    private readonly snapshotProvider: () => Promise<DbSnapshot | null>,
    private readonly onVaultKeyUpdate?: OnVaultKeyUpdate,
    private readonly onSnapshotUpdate?: (snapshot: DbSnapshot) => Promise<void>,
  ) {
    this.app = express();
    this.app.use(express.json());
    this.app.use((req: Request, _res: Response, next: NextFunction) => {
      console.log(`[guardian-http] ${req.method} ${req.path}`);
      next();
    });
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.post('/ping', (req: Request, res: Response) => {
      const envelope = req.body as PingEnvelope;
      if (!envelope || !envelope.teeInstanceId || !envelope.timestamp || !envelope.nonce) {
        res.status(400).json({ ok: false, error: 'missing required ping envelope fields' });
        return;
      }
      try {
        this.livenessMonitor.onPingReceived(envelope);
        res.json({ ok: true });
      } catch {
        res.status(400).json({ ok: false, error: 'invalid_ping' });
      }
    });

    this.app.post('/admission', asyncWrap(async (req, res) => {
      const payload = req.body as AdmissionPayload;
      await this.onAdmission(payload);
      res.json({ accepted: true });
    }));

    this.app.post('/recovery', asyncWrap(async (req, res) => {
      const { snapshot } = req.body as { snapshot?: DbSnapshot };
      if (!snapshot || !this.onSnapshotUpdate) {
        res.status(400).json({ error: 'missing snapshot or handler not set' });
        return;
      }
      await this.onSnapshotUpdate(snapshot);
      console.log('[guardian] DB snapshot updated from primary push');
      res.json({ ok: true });
    }));

    this.app.post('/api/vault-key-update', asyncWrap(async (req, res) => {
      // Validate identity via x-agent-envelope header
      const envelopeHeader = req.headers['x-agent-envelope'];
      if (!envelopeHeader) {
        res.status(401).json({ error: 'missing x-agent-envelope header' });
        return;
      }

      let envelope: PingEnvelope;
      try {
        envelope = JSON.parse(envelopeHeader as string) as PingEnvelope;
      } catch {
        res.status(401).json({ error: 'invalid x-agent-envelope header' });
        return;
      }

      if (!envelope.teeInstanceId || !envelope.timestamp || !envelope.nonce || !envelope.signature) {
        res.status(401).json({ error: 'incomplete envelope in header' });
        return;
      }

      // In DEV_MODE, accept without signature verification
      if (process.env.DEV_MODE !== 'true') {
        // TODO: verify envelope signature against stored peer public key
        console.warn('[guardian-http] signature verification not yet implemented for /api/vault-key-update');
      }

      if (!this.onVaultKeyUpdate) {
        res.status(501).json({ error: 'vault key update handler not configured' });
        return;
      }

      const payload = req.body as VaultKeyUpdatePayload;
      if (!payload.wrappedKey || !payload.snapshot) {
        res.status(400).json({ error: 'missing wrappedKey or snapshot' });
        return;
      }

      await this.onVaultKeyUpdate(payload);
      console.log('[guardian-http] vault key updated via rotation');
      res.json({ ok: true });
    }));

    // Error handler
    this.app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      console.error('[guardian-http] unhandled error:', err.message);
      res.status(500).json({ error: 'internal server error' });
    });
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        console.log(`[guardian-http] listening on port ${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
