/**
 * Guardian REST API routes.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { BackupStorage } from '../guardian/storage.js';
import type { PeerRegistry } from '../guardian/peers.js';
import type { HealthMonitor } from '../guardian/health-monitor.js';
import type { RpcRegistry } from '../guardian/rpc-registry.js';
import type { RpcTester } from '../guardian/rpc-tester.js';
import type { DelegationTracker } from '../guardian/delegations.js';
import type { RecoveryProvider } from '../guardian/recovery.js';
import type { NFTStakingManager } from '../guardian/nft-staking.js';

export interface ApiDeps {
  storage: BackupStorage;
  peers: PeerRegistry;
  health: HealthMonitor;
  rpcRegistry: RpcRegistry;
  rpcTester: RpcTester;
  delegations: DelegationTracker;
  recovery: RecoveryProvider;
  guardianAddress: string;
  nftStaking?: NFTStakingManager;
}

export function createRouter(deps: ApiDeps): Router {
  const router = Router();

  // ── Status ────────────────────────────────────────────────

  router.get('/status', (_req: Request, res: Response) => {
    const latestHealth = deps.health.getLatest();
    const peerStats = deps.peers.stats();
    const rpcStats = deps.rpcRegistry.stats();
    const delegationStats = deps.delegations.stats();
    const storageStats = deps.recovery.getStorageStats();

    res.json({
      guardian: deps.guardianAddress,
      health: latestHealth,
      peers: peerStats,
      rpcs: rpcStats,
      delegations: delegationStats,
      backups: storageStats,
    });
  });

  // ── Backups ───────────────────────────────────────────────

  router.post('/backups', (req: Request, res: Response) => {
    const { timestamp, data, fundManagerId, attestation } = req.body;
    if (!timestamp || !data || !fundManagerId) {
      res.status(400).json({ error: 'Missing timestamp, data, or fundManagerId' });
      return;
    }
    const buf = Buffer.from(data, 'base64');
    const id = deps.storage.store({ timestamp, data: buf, fundManagerId, attestation });
    res.status(201).json({ id });
  });

  router.get('/backups', (_req: Request, res: Response) => {
    const limit = Number(_req.query.limit) || 50;
    res.json(deps.storage.list(limit));
  });

  router.get('/backups/latest', (_req: Request, res: Response) => {
    const backup = deps.storage.getLatest();
    if (!backup) {
      res.status(404).json({ error: 'No backups' });
      return;
    }
    // Return metadata only; use /recovery for full data
    const { data: _, ...meta } = backup;
    res.json(meta);
  });

  // ── Recovery ──────────────────────────────────────────────

  router.post('/recovery', async (req: Request, res: Response) => {
    const result = await deps.recovery.handleRecovery(req.body);
    if (!result.success) {
      res.status(result.error === 'No backups available' ? 404 : 400).json(result);
      return;
    }
    // Send backup data as base64
    res.json({
      ...result,
      backup: result.backup
        ? { ...result.backup, data: result.backup.data.toString('base64') }
        : undefined,
    });
  });

  // ── Peers ─────────────────────────────────────────────────

  router.post('/peers', (req: Request, res: Response) => {
    const { address, endpoint, isSentry, metadata } = req.body;
    if (!address || !endpoint) {
      res.status(400).json({ error: 'Missing address or endpoint' });
      return;
    }
    const isNew = deps.peers.upsert({ address, endpoint, isSentry, metadata });
    res.status(isNew ? 201 : 200).json({ registered: true, new: isNew });
  });

  router.get('/peers', (req: Request, res: Response) => {
    const sentryOnly = req.query.sentry === 'true';
    const activeOnly = req.query.active === 'true';
    if (activeOnly) {
      res.json(deps.peers.listActive());
    } else {
      res.json(deps.peers.listAll(sentryOnly));
    }
  });

  router.post('/peers/:address/heartbeat', (req: Request, res: Response) => {
    const ok = deps.peers.heartbeat(req.params.address as string);
    if (!ok) {
      res.status(404).json({ error: 'Peer not found' });
      return;
    }
    res.json({ ok: true });
  });

  // ── Health ────────────────────────────────────────────────

  router.post('/health/check', async (_req: Request, res: Response) => {
    const result = await deps.health.check();
    res.json(result);
  });

  router.get('/health/history', (req: Request, res: Response) => {
    const limit = Number(req.query.limit) || 50;
    res.json(deps.health.getHistory(limit));
  });

  router.get('/health/stats', (req: Request, res: Response) => {
    const hours = Number(req.query.hours) || 24;
    res.json(deps.health.getStatusCounts(hours));
  });

  // ── RPC Registry ──────────────────────────────────────────

  router.get('/rpcs', (req: Request, res: Response) => {
    const chain = req.query.chain as string | undefined;
    if (chain) {
      res.json(deps.rpcRegistry.listByChain(chain));
    } else {
      res.json(deps.rpcRegistry.listAll());
    }
  });

  router.get('/rpcs/best/:chain', (req: Request, res: Response) => {
    const chain = req.params.chain as string;
    const best = deps.rpcRegistry.getBest(chain);
    if (!best) {
      res.status(404).json({ error: `No active RPC for chain: ${chain}` });
      return;
    }
    res.json(best);
  });

  router.post('/rpcs', (req: Request, res: Response) => {
    const { chain, url, addedBy } = req.body;
    if (!chain || !url || !addedBy) {
      res.status(400).json({ error: 'Missing chain, url, or addedBy' });
      return;
    }
    try {
      const id = deps.rpcRegistry.add({ chain, url, addedBy });
      res.status(201).json({ id });
    } catch (err) {
      // UNIQUE constraint on url
      res.status(409).json({ error: 'RPC URL already registered' });
    }
  });

  router.post('/rpcs/test', async (_req: Request, res: Response) => {
    const results = await deps.rpcTester.testAll();
    res.json(results);
  });

  router.post('/rpcs/test/:chain', async (req: Request, res: Response) => {
    const results = await deps.rpcTester.testChain(req.params.chain as string);
    res.json(results);
  });

  router.get('/rpcs/:id/history', (req: Request, res: Response) => {
    const rpcId = Number(req.params.id as string);
    res.json(deps.rpcRegistry.getTestHistory(rpcId));
  });

  // ── Delegations ───────────────────────────────────────────

  router.post('/delegations', (req: Request, res: Response) => {
    const { delegatorTgId, sentryAddress, nftTokenIds, totalValue, signature, expiresAt } =
      req.body;
    if (!delegatorTgId || !sentryAddress || !nftTokenIds || !signature || !expiresAt) {
      res.status(400).json({ error: 'Missing required delegation fields' });
      return;
    }
    const id = deps.delegations.create({
      delegatorTgId,
      sentryAddress,
      nftTokenIds,
      totalValue: totalValue ?? 0,
      signature,
      expiresAt,
    });
    res.status(201).json({ id });
  });

  router.get('/delegations/sentry/:address', (req: Request, res: Response) => {
    res.json(deps.delegations.getForSentry(req.params.address as string));
  });

  router.get('/delegations/delegator/:tgId', (req: Request, res: Response) => {
    res.json(deps.delegations.getByDelegator(req.params.tgId as string));
  });

  router.delete('/delegations/:id', (req: Request, res: Response) => {
    const delegatorTgId = req.query.delegatorTgId as string;
    if (!delegatorTgId) {
      res.status(400).json({ error: 'Missing delegatorTgId query param' });
      return;
    }
    const ok = deps.delegations.revoke(Number(req.params.id as string), delegatorTgId);
    if (!ok) {
      res.status(404).json({ error: 'Delegation not found or not owned by delegator' });
      return;
    }
    res.json({ revoked: true });
  });

  router.get('/delegations/power', (_req: Request, res: Response) => {
    res.json(deps.delegations.getAllVotingPower());
  });

  router.get('/delegations/power/:address', (req: Request, res: Response) => {
    res.json(deps.delegations.getVotingPower(req.params.address as string));
  });

  router.post('/delegations/update-values', async (_req: Request, res: Response) => {
    const updated = await deps.delegations.updateValues();
    res.json({ updated });
  });

  // ── Staking ────────────────────────────────────────────────

  if (deps.nftStaking) {
    const staking = deps.nftStaking;

    router.post('/staking/stake', async (req: Request, res: Response) => {
      const { guardianAddress, ownerTgId, tokenIds } = req.body;
      if (!guardianAddress || !ownerTgId || !Array.isArray(tokenIds) || tokenIds.length === 0) {
        res.status(400).json({ error: 'Missing guardianAddress, ownerTgId, or tokenIds[]' });
        return;
      }
      try {
        const result = await staking.stakeNFTs(guardianAddress, ownerTgId, tokenIds);
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
      }
    });

    router.post('/staking/unstake', (req: Request, res: Response) => {
      const { guardianAddress, ownerTgId } = req.body;
      if (!guardianAddress || !ownerTgId) {
        res.status(400).json({ error: 'Missing guardianAddress or ownerTgId' });
        return;
      }
      // Check vote lock before unstaking
      if (staking.checkVoteLock(guardianAddress)) {
        res.status(409).json({ error: 'Cannot unstake: guardian has active votes in the last 48h' });
        return;
      }
      const unstaked = staking.unstakeByOwner(guardianAddress, ownerTgId);
      res.json({ unstaked });
    });

    router.get('/staking/guardian/:address', (req: Request, res: Response) => {
      const stakes = staking.getActiveStakes(req.params.address as string);
      const totalValue = staking.getTotalStakedValue(req.params.address as string);
      res.json({ stakes, totalValue });
    });

    router.get('/staking/owner/:tgId', (req: Request, res: Response) => {
      const stakes = staking.getStakesByOwner(req.params.tgId as string);
      res.json({ stakes });
    });
  }

  return router;
}
