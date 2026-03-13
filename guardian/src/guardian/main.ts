/**
 * Guardian Network entry point.
 * Initializes database, modules, API server, and background jobs.
 */
import { createDatabase } from '../shared/db.js';
import { BackupStorage } from './storage.js';
import { PeerRegistry } from './peers.js';
import { HealthMonitor } from './health-monitor.js';
import { RpcRegistry } from './rpc-registry.js';
import { RpcTester } from './rpc-tester.js';
import { DelegationTracker } from './delegations.js';
import { RecoveryProvider } from './recovery.js';
import { ProposalManager } from '../sentry/proposals.js';
import { VotingSystem } from '../sentry/voting.js';
import { CodeReviewer } from '../sentry/code-reviewer.js';
import { StrategyGovernance } from '../sentry/strategy-governance.js';
import { ConfigGovernance, EXECUTABLE_CONFIG_TYPES } from '../sentry/config-governance.js';
import { NFTVerifier } from '../sentry/nft-verifier.js';
import { NFTStakingManager } from './nft-staking.js';
import { AgentVerifier, createApprovedCodeSet, attemptOrderedFailover } from '../sentry/agent-verification.js';
import type { BackupAgentEntry } from '../sentry/agent-verification.js';
import Database from 'better-sqlite3';
import { RegistrationVoting } from '../sentry/registration-voting.js';
import { LocalRegistryClient } from '../shared/registry-client.js';
import { EvmDiscoveryClient } from '../shared/evm-discovery.js';
import { createServer } from '../api/server.js';
import { createGuardianBot, sendToGroup } from './telegram.js';
import { formatGuardianAnnounce, formatProposalResult } from '../shared/telegram-protocol.js';
import { createTEESigner, loadAttestationQuote } from '../shared/tee-signer.js';
import { TrustStore } from '../shared/trust-store.js';
import { AttestationVerifier } from '../shared/attestation-verifier.js';
import { generateVaultKey, unwrapVaultKey, type WrappedVaultKey } from '../shared/vault.js';
import { DBSnapshotReceiver, type DBSyncConfig } from './db-sync.js';
import type { GuardianConfig } from '../shared/types.js';

interface FullConfig extends GuardianConfig {
  /** Enable sentry governance features. */
  isSentry: boolean;
  /** Telegram bot token for this guardian. */
  telegramBotToken?: string;
  /** Shared Telegram group chat ID for protocol messages. */
  telegramGroupChatId?: string;
}

const DEFAULT_CONFIG: FullConfig = {
  address: process.env.GUARDIAN_ADDRESS ?? 'guardian-1',
  port: Number(process.env.PORT) || 3100,
  fundManagerEndpoint: process.env.FUND_MANAGER_ENDPOINT ?? 'http://localhost:3000',
  dbPath: process.env.DB_PATH ?? 'guardian.db',
  maxBackups: Number(process.env.MAX_BACKUPS) || 1000,
  isSentry: process.env.IS_SENTRY === 'true',
  telegramBotToken: process.env.GUARDIAN_TELEGRAM_BOT_TOKEN,
  telegramGroupChatId: process.env.TELEGRAM_GROUP_CHAT_ID,
};

function loadConfig(): FullConfig {
  return { ...DEFAULT_CONFIG };
}

/**
 * Request the vault key from the agent via attestation exchange.
 * Sends this guardian's attestation quote + X25519 pubkey; agent verifies
 * and returns the vault key wrapped with ECDH shared secret.
 */
async function requestVaultKeyFromAgent(
  agentEndpoint: string,
  signer: Awaited<ReturnType<typeof createTEESigner>>,
): Promise<Buffer> {
  const attestationQuote = loadAttestationQuote();
  if (!attestationQuote) {
    throw new Error('No local attestation quote available');
  }

  const body = JSON.stringify({
    ed25519Pubkey: signer.ed25519PubkeyBase64,
    attestationQuote,
    x25519Pubkey: signer.x25519PubkeyBase64,
    x25519Signature: signer.x25519Signature,
    senderId: process.env.GUARDIAN_ADDRESS ?? 'guardian',
  });

  const url = `${agentEndpoint.replace(/\/$/, '')}/api/attestation`;
  console.log(`[Guardian] Requesting vault key from agent at ${url}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Agent returned ${res.status}: ${text}`);
  }

  const data = await res.json() as {
    success: boolean;
    error?: string;
    wrappedVaultKey?: WrappedVaultKey;
    senderEd25519Pubkey?: string;
  };

  if (!data.success || !data.wrappedVaultKey || !data.senderEd25519Pubkey) {
    throw new Error(data.error ?? 'No wrapped vault key in response');
  }

  return unwrapVaultKey(data.wrappedVaultKey, signer, data.senderEd25519Pubkey);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const externalEndpoint = process.env.GUARDIAN_EXTERNAL_ENDPOINT ?? `http://0.0.0.0:${config.port}`;
  console.log(`[Guardian] Starting ${config.address} on port ${config.port}`);
  console.log(`[Guardian] Fund manager: ${config.fundManagerEndpoint}`);
  console.log(`[Guardian] Database: ${config.dbPath}`);

  // Initialize database
  const db = createDatabase(config.dbPath);

  // ── TEE Signing + Trust Bootstrap ──────────────────────────
  const signer = await createTEESigner();
  console.log(`[Guardian] TEE signer initialized (production: ${signer.isProduction})`);
  console.log(`[Guardian] ed25519 pubkey: ${signer.ed25519PubkeyBase64.substring(0, 16)}...`);

  // Trust event callback — wired to Telegram group after bot is created.
  // We use a mutable holder so modules can be constructed before the bot exists.
  let onTrustEvent: ((msg: string) => void) | undefined;

  // Broadcast callback — wired to Telegram group after bot is created.
  let broadcastToGroup: ((msg: string) => void) | undefined;

  const trustStore = new TrustStore(10_000, (msg) => onTrustEvent?.(msg));

  // Approved code measurements for attestation verification
  const approvedMeasurementsEnv = process.env.APPROVED_MEASUREMENTS; // comma-separated hex hashes
  const approvedMeasurements = approvedMeasurementsEnv
    ? new Set(approvedMeasurementsEnv.split(',').map((h) => h.trim()).filter(Boolean))
    : new Set<string>();
  if (approvedMeasurements.size > 0) {
    console.log(`[Guardian] Approved code measurements: ${approvedMeasurements.size}`);
  }

  const requireAttestation = process.env.REQUIRE_INLINE_ATTESTATION === 'true';
  if (requireAttestation) {
    console.log('[Guardian] Per-interaction attestation REQUIRED for DB sync/recovery');
  }

  const attestationVerifier = new AttestationVerifier({
    approvedMeasurements,
    onEvent: (msg) => onTrustEvent?.(msg),
  });

  // Vault key placeholder — resolved after registry discovery below.
  let vaultKey!: Buffer;

  // Trust self (initial — will be updated when isSentryNow changes)
  trustStore.addPeer({
    id: config.address,
    ed25519PubkeyBase64: signer.ed25519PubkeyBase64,
    x25519PubkeyBase64: signer.x25519PubkeyBase64,
    attestedAt: Date.now(),
    lastVerified: Date.now(),
    isSentry: config.isSentry,
  });

  // Initialize modules
  const storage = new BackupStorage(db, config.maxBackups);
  const peers = new PeerRegistry(db);
  const health = new HealthMonitor(db, config.fundManagerEndpoint);
  const rpcRegistry = new RpcRegistry(db);
  const rpcTester = new RpcTester(rpcRegistry);

  // Seed RPC endpoints from environment (if not already registered)
  const seedRpcs = process.env.SEED_RPCS; // Format: "chain=url,chain=url"
  if (seedRpcs) {
    for (const entry of seedRpcs.split(',')) {
      const [chain, ...urlParts] = entry.trim().split('=');
      const url = urlParts.join('='); // Rejoin in case URL contains '='
      if (chain && url && !rpcRegistry.getByUrl(url)) {
        const id = rpcRegistry.add({ chain, url, addedBy: config.address });
        rpcRegistry.setStatus(id, 'active');
        rpcRegistry.adjustReputation(id, 10); // Start with good reputation
        console.log(`[Guardian] Seeded RPC: ${chain} → ${url}`);
      }
    }
  }
  const nftVerifier = new NFTVerifier(config.fundManagerEndpoint);
  const nftStaking = new NFTStakingManager(db, nftVerifier, config.fundManagerEndpoint);
  const delegations = new DelegationTracker(db, config.fundManagerEndpoint, {
    getOwnValue: (addr) => nftStaking.getTotalStakedValue(addr),
  });
  // Initialize sentry governance modules (if this node is a sentry)
  const proposals = new ProposalManager(db);
  const voting = new VotingSystem(db, proposals, delegations);
  const codeReviewer = new CodeReviewer();
  const strategyGov = new StrategyGovernance(db, proposals, voting, config.fundManagerEndpoint);
  const configGov = new ConfigGovernance(db, proposals, voting, config.fundManagerEndpoint);

  // ── EVM Discovery Registry ────────────────────────────────
  const registryContractAddress = process.env.REGISTRY_CONTRACT_ADDRESS;
  let evmDiscovery: EvmDiscoveryClient | undefined;

  if (registryContractAddress) {
    const evmRpcUrl = process.env.EVM_RPC_URL ?? 'https://sepolia.base.org';
    // Guardian reads the registry to discover the agent endpoint.
    // Guardians find each other through the agent, not the registry.
    // Read-only — no wallet or gas needed.
    evmDiscovery = new EvmDiscoveryClient(
      evmRpcUrl,
      registryContractAddress as `0x${string}`,
    );

    // Discover agent endpoint from registry
    try {
      const agents = await evmDiscovery.getAgents();
      const activeAgent = agents.find(a => a.isActive);
      if (activeAgent) {
        config.fundManagerEndpoint = activeAgent.endpoint;
        console.log(`[Guardian] Discovered agent at ${activeAgent.endpoint}`);
      } else {
        console.log('[Guardian] No active agent found in registry — using configured endpoint');
      }
    } catch (err) {
      console.warn(`[Guardian] Registry agent discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Resolve vault key ─────────────────────────────────────────
  const vaultKeyHex = process.env.VAULT_KEY;
  if (vaultKeyHex) {
    vaultKey = Buffer.from(vaultKeyHex, 'hex');
    console.log('[Guardian] Vault key loaded from env var');
  } else if (config.fundManagerEndpoint && config.fundManagerEndpoint !== DEFAULT_CONFIG.fundManagerEndpoint) {
    // Agent was discovered from registry — request vault key via attestation
    try {
      vaultKey = await requestVaultKeyFromAgent(config.fundManagerEndpoint, signer);
      console.log('[Guardian] Vault key obtained from agent via attestation');
    } catch (err) {
      console.warn(`[Guardian] Vault key attestation request failed: ${err instanceof Error ? err.message : String(err)}`);
      vaultKey = generateVaultKey();
      console.log('[Guardian] Generated new vault key (fallback)');
    }
  } else {
    vaultKey = generateVaultKey();
    console.log('[Guardian] Generated new vault key (dev mode)');
  }

  // DB Sync receiver (after vault key is resolved)
  const dbSyncConfig: DBSyncConfig = {
    nodeId: config.address,
    signer,
    vaultKey,
    trustStore,
    onEvent: (msg) => onTrustEvent?.(msg),
    approvedMeasurements,
    requireAttestation,
  };
  const snapshotReceiver = new DBSnapshotReceiver(dbSyncConfig);

  const recovery = new RecoveryProvider(db, config.maxBackups, {
    signer,
    trustStore,
    nodeId: config.address,
    getLatestSnapshot: () => snapshotReceiver.getLatestSnapshot(),
    onEvent: (msg) => onTrustEvent?.(msg),
    approvedMeasurements,
  });

  // Initialize agent verification (Phase E)
  // Always use local registry for governance (writes are in-memory, no SOL needed).
  // Solana registry is only used for read-only endpoint discovery.
  const registryClient = new LocalRegistryClient();
  const approvedCode = createApprovedCodeSet(); // Empty = accept all (dev mode)
  const agentVerifier = new AgentVerifier(registryClient, approvedCode);
  // Single-sentry: auto-approve registrations (no other voters to wait for).
  // When more sentries are added, set autoApprove: false.
  const peerCount = peers.listAll(true).length;
  const autoApprove = peerCount <= 1;
  if (autoApprove) {
    console.log('[Sentry] Single-sentry mode: agent registrations will be auto-approved');
  }
  const registrationVoting = new RegistrationVoting(
    db, registryClient, proposals, voting, approvedCode,
    { autoApprove, trustStore },
  );

  // Dynamic sentry status: env override OR staked NFTs
  const isSentryNow = (): boolean => config.isSentry || nftStaking.hasActiveStakes(config.address);

  // Create and start server — always pass sentry deps so dynamic promotion works
  const app = createServer({
    guardian: {
      storage,
      peers,
      health,
      rpcRegistry,
      rpcTester,
      delegations,
      recovery,
      guardianAddress: config.address,
      nftStaking,
    },
    sentry: {
      proposals, voting, codeReviewer, strategyGov, configGov, nftVerifier,
      agentVerifier, registrationVoting,
      broadcastToGroup: (msg: string) => broadcastToGroup?.(msg),
    },
    sentryGuard: isSentryNow,
    signed: {
      signer,
      trustStore,
      requireSigned: false, // Gradual migration: accept unsigned for now
    },
    attestation: {
      signer,
      trustStore,
      attestationVerifier,
      vaultKey,
      onEvent: (msg) => onTrustEvent?.(msg),
    },
    dbSync: {
      snapshotReceiver,
      onEvent: (msg) => onTrustEvent?.(msg),
    },
  });

  app.listen(config.port, () => {
    console.log(`[Guardian] API listening on http://0.0.0.0:${config.port}`);
    console.log(`[Sentry] Governance endpoints enabled (dynamic, current: ${isSentryNow() ? 'active' : 'inactive'})`);
  });

  // ── Telegram bot ────────────────────────────────────────────
  if (config.telegramBotToken && config.telegramGroupChatId) {
    const ownerChatId = process.env.GUARDIAN_OWNER_TELEGRAM_ID
      ? Number(process.env.GUARDIAN_OWNER_TELEGRAM_ID)
      : undefined;

    const tgBot = createGuardianBot(
      {
        botToken: config.telegramBotToken,
        groupChatId: config.telegramGroupChatId,
        guardianAddress: config.address,
        guardianEndpoint: externalEndpoint,
        isSentry: config.isSentry,
        isSentryNow,
        ownerChatId,
      },
      {
        peers, proposals, voting, delegations, nftVerifier,
        nftStaking,
        configGov: configGov,
        broadcastToGroup: (msg: string) => sendToGroup(tgBot, config.telegramGroupChatId!, msg),
      },
    );

    // Wire trust events and broadcast to the Telegram group
    onTrustEvent = (msg) => {
      sendToGroup(tgBot, config.telegramGroupChatId!, msg);
    };
    broadcastToGroup = (msg) => {
      sendToGroup(tgBot, config.telegramGroupChatId!, msg);
    };

    tgBot.start({
      onStart: async () => {
        console.log('[Guardian] Telegram bot started polling');
        // Announce self to group on startup
        const announce = formatGuardianAnnounce({
          address: config.address,
          endpoint: externalEndpoint,
          isSentry: isSentryNow(),
        });
        await sendToGroup(tgBot, config.telegramGroupChatId!, announce);
      },
    });
  } else {
    console.log('[Guardian] Telegram bot disabled (no GUARDIAN_TELEGRAM_BOT_TOKEN or TELEGRAM_GROUP_CHAT_ID)');
  }

  // ── Background jobs ──────────────────────────────────────

  // Health check every 10 minutes
  setInterval(async () => {
    try {
      const { check, anomalies } = await health.check();
      console.log(`[Health] ${check.status} — pool: ${check.pool_balance ?? '?'}`);
      for (const a of anomalies) {
        console.warn(`[ANOMALY] ${a.type}: ${a.message}`);
      }
    } catch (err) {
      console.error('[Health] Check failed:', err);
    }
  }, 10 * 60 * 1000);

  // RPC testing every 30 minutes
  setInterval(async () => {
    try {
      const results = await rpcTester.testAll();
      const ok = results.filter((r) => r.success).length;
      const fail = results.length - ok;
      console.log(`[RPC] Tested ${results.length}: ${ok} ok, ${fail} failed`);
      const deprecated = results.filter((r) => r.deprecated);
      for (const d of deprecated) {
        console.warn(`[RPC] Auto-deprecated: ${d.url} (rep: ${d.newReputation})`);
      }
    } catch (err) {
      console.error('[RPC] Test cycle failed:', err);
    }
  }, 30 * 60 * 1000);

  // Peer stale pruning every 15 minutes
  setInterval(() => {
    const pruned = peers.pruneStale();
    if (pruned > 0) console.log(`[Peers] Pruned ${pruned} stale peers`);
  }, 15 * 60 * 1000);

  // Delegation value updates + NFT stake reverification every hour
  setInterval(async () => {
    try {
      delegations.expireOld();
      const updated = await delegations.updateValues();
      console.log(`[Delegations] Updated ${updated} delegation values`);
    } catch (err) {
      console.error('[Delegations] Value update failed:', err);
    }
    try {
      const { updated, revoked } = await nftStaking.reverify();
      console.log(`[NFTStaking] Reverify: ${updated} updated, ${revoked} revoked`);
    } catch (err) {
      console.error('[NFTStaking] Reverify failed:', err);
    }
  }, 60 * 60 * 1000);

  // Proposal resolution every 5 minutes (resolve expired proposals)
  setInterval(async () => {
    if (!isSentryNow()) return;
    try {
      proposals.expireOverdue();
      const poolValue = await nftVerifier.getTotalPoolValue();
      if (poolValue > 0) {
        const resolved = voting.resolveExpired(poolValue);
        for (const r of resolved) {
          console.log(
            `[Sentry] Proposal ${r.proposalId}: ${r.passed ? 'PASSED' : 'FAILED'} (${r.approvalPct.toFixed(1)}% / ${r.thresholdPct}%)`,
          );
          // Broadcast result to group
          broadcastToGroup?.(formatProposalResult({
            id: r.proposalId,
            status: r.passed ? 'approved' : 'rejected',
            approvalPct: Math.round(r.approvalPct * 10) / 10,
          }));
          // Auto-execute passed proposals
          if (r.passed) {
            const proposal = proposals.getById(r.proposalId);
            if (proposal?.type === 'agent_registration') {
              const exec = await registrationVoting.executeRegistration(r.proposalId);
              console.log(`[Sentry] Agent registration execution: ${exec.success ? 'OK' : exec.error}`);
            } else if (proposal && EXECUTABLE_CONFIG_TYPES.has(proposal.type)) {
              const exec = await configGov.executeChange(r.proposalId);
              console.log(`[Sentry] Config change (${proposal.type}) execution: ${exec.success ? 'OK' : exec.error}`);
            }
          }
        }
      }
    } catch (err) {
      console.error('[Sentry] Proposal resolution failed:', err);
    }
  }, 5 * 60 * 1000);

  // Agent heartbeat monitoring every 30 seconds
  setInterval(async () => {
    if (!isSentryNow()) return;
    try {
      const result = await agentVerifier.checkHealth();
      if (result.deactivated) {
        console.warn('[Sentry] Active agent deactivated due to heartbeat timeout');

        // ── Ordered Failover: contact backups from DB snapshot ──
        try {
          const decryptedDb = snapshotReceiver.decryptLatest();
          if (decryptedDb) {
            // Open the decrypted snapshot as a temporary SQLite database
            const tmpPath = `${config.dbPath}.failover-tmp`;
            const { writeFileSync, unlinkSync } = await import('node:fs');
            writeFileSync(tmpPath, decryptedDb);
            const tmpDb = new Database(tmpPath);

            try {
              // Check if backup_agents table exists
              const tableExists = tmpDb.prepare(
                `SELECT name FROM sqlite_master WHERE type='table' AND name='backup_agents'`
              ).get();

              if (tableExists) {
                const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
                const cutoff = Date.now() - TWO_HOURS_MS;
                const backupList = tmpDb.prepare(
                  `SELECT id, endpoint, registered_at, last_heartbeat, heartbeat_streak FROM backup_agents
                   WHERE last_heartbeat > ? ORDER BY heartbeat_streak DESC, registered_at ASC`
                ).all(cutoff) as BackupAgentEntry[];

                console.log(`[Sentry] Found ${backupList.length} fresh backup agent(s) in snapshot`);

                if (backupList.length > 0) {
                  const failoverResult = await attemptOrderedFailover(backupList, {
                    proposeRegistration: (request) => registrationVoting.handleRegistrationRequest(request),
                  });

                  if (failoverResult.success) {
                    console.log(`[Sentry] Ordered failover initiated with backup ${failoverResult.contactedId?.substring(0, 16)}...`);
                    broadcastToGroup?.(`[FAILOVER] Contacted backup agent at ${failoverResult.contactedEndpoint} for takeover`);
                  } else {
                    console.warn(`[Sentry] Ordered failover failed: ${failoverResult.error}`);
                    broadcastToGroup?.(`[FAILOVER] No backup agents available — manual intervention needed`);
                  }
                }
              } else {
                console.log('[Sentry] No backup_agents table in snapshot — ordered failover not available');
              }
            } finally {
              tmpDb.close();
              try { unlinkSync(tmpPath); } catch { /* best effort cleanup */ }
            }
          } else {
            console.log('[Sentry] No DB snapshot available for failover');
          }
        } catch (err) {
          console.error('[Sentry] Ordered failover error:', err instanceof Error ? err.message : err);
        }
      }
    } catch (err) {
      console.error('[Sentry] Agent health check failed:', err);
    }
  }, 30 * 1000);

  // EVM registry re-discovery every 5 minutes (read-only, no gas needed)
  if (evmDiscovery) {
    setInterval(async () => {
      try {
        const agents = await evmDiscovery!.getAgents();
        const activeAgent = agents.find(a => a.isActive);
        if (activeAgent && activeAgent.endpoint !== config.fundManagerEndpoint) {
          config.fundManagerEndpoint = activeAgent.endpoint;
          health.updateEndpoint(activeAgent.endpoint);
          console.log(`[Guardian] Re-discovered agent at ${activeAgent.endpoint}`);
        }
      } catch (err) {
        console.warn(`[Guardian] Registry re-discovery failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, 5 * 60 * 1000);
  }

  // Register self as a peer
  peers.upsert({
    address: config.address,
    endpoint: externalEndpoint,
    isSentry: isSentryNow(),
  });

  // Refresh self-registration every 5 minutes to propagate sentry status changes
  setInterval(() => {
    peers.upsert({
      address: config.address,
      endpoint: externalEndpoint,
      isSentry: isSentryNow(),
    });
  }, 5 * 60 * 1000);

  console.log('[Guardian] All systems online');
}

main().catch((err) => {
  console.error('[Guardian] Fatal error:', err);
  process.exit(1);
});
