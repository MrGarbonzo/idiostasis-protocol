import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { HandlerDeps } from './handlers.js';
import {
  handleStatus,
  handlePing,
  handleAdmission,
  handleEvmAddress,
  handleWorkload,
  handleDiscover,
  handleBackupReady,
  handleBackupConfirm,
  handleRegisterErc8004,
} from './handlers.js';

type AsyncHandler = (req: Request, res: Response) => Promise<void>;

function asyncWrap(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

export class HttpServer {
  private readonly app: ReturnType<typeof express>;
  private server: ReturnType<ReturnType<typeof express>['listen']> | null = null;

  constructor(private readonly deps: HandlerDeps) {
    this.app = express();
    this.app.use(express.json());
    this.app.use((req: Request, _res: Response, next: NextFunction) => {
      console.log(`[http] ${req.method} ${req.path}`);
      next();
    });
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.get('/status', asyncWrap(async (_req, res) => {
      res.json(await handleStatus(this.deps));
    }));

    this.app.post('/ping', asyncWrap(async (req, res) => {
      res.json(await handlePing(this.deps, req.body));
    }));

    this.app.post('/api/admission', asyncWrap(async (req, res) => {
      const raw = (req.headers['x-forwarded-for'] as string)
        ?.split(',')[0].trim()
        ?? req.socket.remoteAddress
        ?? '';
      const sourceIp = raw.replace(/^::ffff:/, '');
      res.json(await handleAdmission(this.deps, req.body, sourceIp));
    }));

    this.app.get('/api/evm-address', asyncWrap(async (_req, res) => {
      res.json(await handleEvmAddress(this.deps));
    }));

    this.app.get('/workload', asyncWrap(async (_req, res) => {
      res.json(await handleWorkload(this.deps));
    }));

    this.app.get('/discover', asyncWrap(async (_req, res) => {
      res.json(await handleDiscover(this.deps));
    }));

    this.app.post('/api/backup/ready', asyncWrap(async (req, res) => {
      res.json(await handleBackupReady(this.deps, req.body));
    }));

    this.app.post('/api/backup/confirm', asyncWrap(async (req, res) => {
      res.json(await handleBackupConfirm(this.deps, req.body));
    }));

    this.app.post('/api/register-erc8004', asyncWrap(async (req, res) => {
      res.json(await handleRegisterErc8004(this.deps, req.body));
    }));

    // Error handler
    this.app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      console.error('[http] unhandled error:', err.message);
      res.status(500).json({ error: 'internal server error' });
    });
  }

  start(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(port, () => {
        console.log(`[http] listening on port ${port}`);
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
