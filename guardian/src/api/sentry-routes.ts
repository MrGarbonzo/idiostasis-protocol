/**
 * Sentry governance API routes.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ProposalManager } from '../sentry/proposals.js';
import type { VotingSystem } from '../sentry/voting.js';
import type { CodeReviewer } from '../sentry/code-reviewer.js';
import type { StrategyGovernance } from '../sentry/strategy-governance.js';
import type { ConfigGovernance } from '../sentry/config-governance.js';
import type { NFTVerifier } from '../sentry/nft-verifier.js';
import type { AgentVerifier } from '../sentry/agent-verification.js';
import type { RegistrationVoting } from '../sentry/registration-voting.js';
import type { ProposalType } from '../shared/types.js';
import { formatProposalNew } from '../shared/telegram-protocol.js';

export interface SentryApiDeps {
  proposals: ProposalManager;
  voting: VotingSystem;
  codeReviewer: CodeReviewer;
  strategyGov: StrategyGovernance;
  configGov?: ConfigGovernance;
  nftVerifier: NFTVerifier;
  agentVerifier?: AgentVerifier;
  registrationVoting?: RegistrationVoting;
  broadcastToGroup?: (msg: string) => void;
}

export function createSentryRouter(deps: SentryApiDeps): Router {
  const router = Router();

  // ── Proposals ─────────────────────────────────────────────

  router.post('/proposals', (req: Request, res: Response) => {
    const { type, proposer, description, data, thresholdPct, deadlineHours } = req.body;
    if (!type || !proposer || !description) {
      res.status(400).json({ error: 'Missing type, proposer, or description' });
      return;
    }
    try {
      const id = deps.proposals.create({
        type: type as ProposalType,
        proposer,
        description,
        data,
        thresholdPct,
        deadlineHours,
      });
      const proposal = deps.proposals.getById(id);
      if (proposal && deps.broadcastToGroup) {
        deps.broadcastToGroup(formatProposalNew({
          id,
          type: proposal.type,
          thresholdPct: proposal.threshold_pct,
          deadline: proposal.deadline,
        }));
      }
      res.status(201).json({ id });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/proposals', (req: Request, res: Response) => {
    const status = req.query.status as string | undefined;
    if (status === 'active') {
      res.json(deps.proposals.listActive());
    } else {
      // Return all active by default
      res.json(deps.proposals.listActive());
    }
  });

  router.get('/proposals/:id', (req: Request, res: Response) => {
    const proposal = deps.proposals.getById(req.params.id as string);
    if (!proposal) {
      res.status(404).json({ error: 'Proposal not found' });
      return;
    }
    res.json(proposal);
  });

  router.get('/proposals/stats', (_req: Request, res: Response) => {
    res.json(deps.proposals.stats());
  });

  // ── Voting ────────────────────────────────────────────────

  router.post('/proposals/:id/vote', (req: Request, res: Response) => {
    const { voterAddress, approve, attestation } = req.body;
    if (!voterAddress || approve === undefined) {
      res.status(400).json({ error: 'Missing voterAddress or approve' });
      return;
    }
    try {
      const result = deps.voting.castVote({
        proposalId: req.params.id as string,
        voterAddress,
        approve: Boolean(approve),
        attestation,
      });
      res.status(201).json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = msg.includes('not found') ? 404 : msg.includes('UNIQUE') ? 409 : 400;
      res.status(status).json({ error: msg });
    }
  });

  router.get('/proposals/:id/votes', (req: Request, res: Response) => {
    res.json(deps.voting.getVotes(req.params.id as string));
  });

  router.get('/proposals/:id/tally', (req: Request, res: Response) => {
    const totalPoolValue = Number(req.query.totalPoolValue) || 0;
    try {
      const result = deps.voting.tally(req.params.id as string, totalPoolValue);
      res.json(result);
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/proposals/:id/resolve', (req: Request, res: Response) => {
    const totalPoolValue = Number(req.body.totalPoolValue) || 0;
    try {
      const result = deps.voting.resolve(req.params.id as string, totalPoolValue);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Code Review ───────────────────────────────────────────

  router.post('/review/diff', (req: Request, res: Response) => {
    const { diff } = req.body;
    if (!diff) {
      res.status(400).json({ error: 'Missing diff' });
      return;
    }
    const result = deps.codeReviewer.reviewDiff(diff);
    res.json(result);
  });

  router.post('/review/source', (req: Request, res: Response) => {
    const { source } = req.body;
    if (!source) {
      res.status(400).json({ error: 'Missing source' });
      return;
    }
    const result = deps.codeReviewer.reviewSource(source);
    res.json(result);
  });

  router.post('/review/docker-image', async (req: Request, res: Response) => {
    const { imageTag, expectedHash } = req.body;
    if (!imageTag || !expectedHash) {
      res.status(400).json({ error: 'Missing imageTag or expectedHash' });
      return;
    }
    const result = await deps.codeReviewer.verifyDockerImage(imageTag, expectedHash);
    res.json(result);
  });

  // ── Strategy Governance ───────────────────────────────────

  router.post('/strategy/propose-switch', (req: Request, res: Response) => {
    const { proposer, currentStrategy, targetStrategy, reason } = req.body;
    if (!proposer || !currentStrategy || !targetStrategy || !reason) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }
    const id = deps.strategyGov.proposeStrategySwitch({
      proposer,
      currentStrategy,
      targetStrategy,
      reason,
    });
    const proposal = deps.proposals.getById(id);
    if (proposal && deps.broadcastToGroup) {
      deps.broadcastToGroup(formatProposalNew({
        id,
        type: proposal.type,
        thresholdPct: proposal.threshold_pct,
        deadline: proposal.deadline,
      }));
    }
    res.status(201).json({ id });
  });

  router.post('/strategy/propose-params', (req: Request, res: Response) => {
    const { proposer, strategy, parameters, reason } = req.body;
    if (!proposer || !strategy || !parameters || !reason) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }
    const id = deps.strategyGov.proposeParameterAdjust({
      proposer,
      strategy,
      parameters,
      reason,
    });
    const proposal = deps.proposals.getById(id);
    if (proposal && deps.broadcastToGroup) {
      deps.broadcastToGroup(formatProposalNew({
        id,
        type: proposal.type,
        thresholdPct: proposal.threshold_pct,
        deadline: proposal.deadline,
      }));
    }
    res.status(201).json({ id });
  });

  router.post('/strategy/execute/:proposalId', async (req: Request, res: Response) => {
    const result = await deps.strategyGov.executeChange(req.params.proposalId as string);
    if (!result.success) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  });

  router.get('/strategy/proposals', (_req: Request, res: Response) => {
    res.json(deps.strategyGov.listStrategyProposals());
  });

  router.get('/strategy/current', async (_req: Request, res: Response) => {
    const current = await deps.strategyGov.getCurrentStrategy();
    if (!current) {
      res.status(503).json({ error: 'Fund manager unreachable' });
      return;
    }
    res.json(current);
  });

  // ── NFT Verification ─────────────────────────────────────

  router.post('/nft/verify', async (req: Request, res: Response) => {
    const { tokenId, ownerTgId } = req.body;
    if (!tokenId || !ownerTgId) {
      res.status(400).json({ error: 'Missing tokenId or ownerTgId' });
      return;
    }
    const proof = await deps.nftVerifier.verifyOwnership(tokenId, ownerTgId);
    res.json(proof);
  });

  router.post('/nft/verify-multiple', async (req: Request, res: Response) => {
    const { tokenIds, ownerTgId } = req.body;
    if (!tokenIds || !ownerTgId) {
      res.status(400).json({ error: 'Missing tokenIds or ownerTgId' });
      return;
    }
    const result = await deps.nftVerifier.verifyMultiple(tokenIds, ownerTgId);
    res.json(result);
  });

  // ── Agent Registration & Verification ───────────────────

  if (deps.agentVerifier && deps.registrationVoting) {
    const agentVerifier = deps.agentVerifier;
    const registrationVoting = deps.registrationVoting;

    router.get('/agent/current', async (_req: Request, res: Response) => {
      const agent = await agentVerifier.getCurrentAgent();
      if (!agent) {
        res.status(404).json({ error: 'No agent registered' });
        return;
      }
      res.json(agent);
    });

    router.post('/agent/register', async (req: Request, res: Response) => {
      const { teeInstanceId, codeHash, attestation, endpoint,
        ed25519PubkeyBase64, x25519PubkeyBase64, x25519Signature } = req.body;
      if (!teeInstanceId || !codeHash) {
        res.status(400).json({ error: 'Missing teeInstanceId or codeHash' });
        return;
      }
      const result = await registrationVoting.handleRegistrationRequest({
        teeInstanceId,
        codeHash,
        attestation: attestation ?? '',
        endpoint: endpoint ?? '',
        ed25519PubkeyBase64,
        x25519PubkeyBase64,
        x25519Signature,
      });
      res.status(result.success ? 201 : 400).json(result);
    });

    router.post('/agent/verify', async (req: Request, res: Response) => {
      const { teeInstanceId, attestation } = req.body;
      if (!teeInstanceId || !attestation) {
        res.status(400).json({ error: 'Missing teeInstanceId or attestation' });
        return;
      }
      const result = await agentVerifier.verifyAgent(teeInstanceId, attestation);
      res.json(result);
    });

    router.post('/agent/heartbeat', async (req: Request, res: Response) => {
      const { teeInstanceId, attestation, timestamp } = req.body;
      if (!teeInstanceId) {
        res.status(400).json({ error: 'Missing teeInstanceId' });
        return;
      }
      const result = await agentVerifier.processHeartbeat({
        teeInstanceId,
        attestation: attestation ?? '',
        timestamp: timestamp ?? Date.now(),
      });
      res.json(result);
    });

    router.get('/agent/heartbeat-check', async (_req: Request, res: Response) => {
      const result = await agentVerifier.checkHealth();
      if (!result.check) {
        res.status(404).json({ error: 'No agent registered' });
        return;
      }
      res.json(result);
    });

    router.post('/agent/deactivate', async (req: Request, res: Response) => {
      const { teeInstanceId } = req.body;
      if (!teeInstanceId) {
        res.status(400).json({ error: 'Missing teeInstanceId' });
        return;
      }
      const current = await agentVerifier.getCurrentAgent();
      if (!current || current.teeInstanceId !== teeInstanceId) {
        res.status(404).json({ error: 'Agent not found or mismatch' });
        return;
      }
      // Deactivate via registry (marks agent inactive on-chain)
      const result = await agentVerifier.deactivateAgent(teeInstanceId);
      if (!result.success) {
        res.status(400).json(result);
        return;
      }
      res.json({ success: true, message: `Agent ${teeInstanceId.slice(0, 12)}... deactivated` });
    });
  }

  // ── Config Governance (generalized) ─────────────────────

  if (deps.configGov) {
    const configGov = deps.configGov;

    router.post('/config/propose', (req: Request, res: Response) => {
      const { type, proposer, description, configData, fundId } = req.body;
      if (!type || !proposer || !description || !configData) {
        res.status(400).json({ error: 'Missing type, proposer, description, or configData' });
        return;
      }
      try {
        const id = configGov.propose({
          type: type as ProposalType,
          proposer,
          description,
          configData,
          fundId,
        });
        const proposal = deps.proposals.getById(id);
        if (proposal && deps.broadcastToGroup) {
          deps.broadcastToGroup(formatProposalNew({
            id,
            type: proposal.type,
            thresholdPct: proposal.threshold_pct,
            deadline: proposal.deadline,
          }));
        }
        res.status(201).json({ id });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    router.post('/config/rpc', (req: Request, res: Response) => {
      const { proposer, action, chain, url, reason, fundId } = req.body;
      if (!proposer || !action || !url) {
        res.status(400).json({ error: 'Missing proposer, action, or url' });
        return;
      }
      try {
        const id = configGov.proposeRpcChange({
          proposer,
          action,
          chain: chain ?? 'solana',
          url,
          reason: reason ?? '',
          fundId,
        });
        const proposal = deps.proposals.getById(id);
        if (proposal && deps.broadcastToGroup) {
          deps.broadcastToGroup(formatProposalNew({
            id,
            type: proposal.type,
            thresholdPct: proposal.threshold_pct,
            deadline: proposal.deadline,
          }));
        }
        res.status(201).json({ id });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    router.post('/config/trading-limits', (req: Request, res: Response) => {
      const { proposer, limits, reason, fundId } = req.body;
      if (!proposer || !limits) {
        res.status(400).json({ error: 'Missing proposer or limits' });
        return;
      }
      try {
        const id = configGov.proposeTradingLimits({
          proposer,
          limits,
          reason: reason ?? '',
          fundId,
        });
        const proposal = deps.proposals.getById(id);
        if (proposal && deps.broadcastToGroup) {
          deps.broadcastToGroup(formatProposalNew({
            id,
            type: proposal.type,
            thresholdPct: proposal.threshold_pct,
            deadline: proposal.deadline,
          }));
        }
        res.status(201).json({ id });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    router.post('/config/pause', (req: Request, res: Response) => {
      const { proposer, action, reason, fundId } = req.body;
      if (!proposer || !action) {
        res.status(400).json({ error: 'Missing proposer or action' });
        return;
      }
      try {
        const id = configGov.proposeEmergencyAction({
          proposer,
          action,
          reason: reason ?? '',
          fundId,
        });
        const proposal = deps.proposals.getById(id);
        if (proposal && deps.broadcastToGroup) {
          deps.broadcastToGroup(formatProposalNew({
            id,
            type: proposal.type,
            thresholdPct: proposal.threshold_pct,
            deadline: proposal.deadline,
          }));
        }
        res.status(201).json({ id });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    router.post('/config/tee-measurement', (req: Request, res: Response) => {
      const { proposer, action, measurement, reason, fundId } = req.body;
      if (!proposer || !action || !measurement) {
        res.status(400).json({ error: 'Missing proposer, action, or measurement' });
        return;
      }
      try {
        const id = configGov.proposeTEEMeasurement({
          proposer,
          action,
          measurement,
          reason: reason ?? '',
          fundId,
        });
        const proposal = deps.proposals.getById(id);
        if (proposal && deps.broadcastToGroup) {
          deps.broadcastToGroup(formatProposalNew({
            id,
            type: proposal.type,
            thresholdPct: proposal.threshold_pct,
            deadline: proposal.deadline,
          }));
        }
        res.status(201).json({ id });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    router.post('/config/execute/:proposalId', async (req: Request, res: Response) => {
      const result = await configGov.executeChange(req.params.proposalId as string);
      if (!result.success) {
        res.status(400).json(result);
        return;
      }
      res.json(result);
    });
  }

  return router;
}
