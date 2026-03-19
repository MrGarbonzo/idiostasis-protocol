import type { MoltbookStateAdapter } from '../state/adapter.js';
import type { MoltbookHealthAdapter } from '../health/adapter.js';
import type {
  AdmissionService,
  AdmissionRequest,
  AdmissionResult,
  HeartbeatManager,
  ProtocolDatabase,
  VaultKeyManager,
  PingEnvelope,
  ProtocolConfig,
  WrappedKey,
  DbSnapshot,
} from '@idiostasis/core';
import {
  ProtocolEventType,
  rotateVaultKey,
  KeyExchangeSession,
  SnapshotManager,
} from '@idiostasis/core';
import type { BackupReadyRequest, VaultKeyTransport } from '@idiostasis/core';
import type { ERC8004Client, EvmWallet } from '@idiostasis/erc8004-client';

export interface StatusResponse {
  role: string;
  teeInstanceId: string;
  healthy: boolean;
  uptime: number;
  recoveryCount: number;
}

export interface HandlerDeps {
  stateAdapter: MoltbookStateAdapter;
  healthAdapter: MoltbookHealthAdapter;
  teeInstanceId: string;
  role: string;
  startTime: number;
  admissionService?: AdmissionService;
  heartbeatManager?: HeartbeatManager;
  db?: ProtocolDatabase;
  agentRtmr3?: string;
  evmAddress?: string;
  erc8004Client?: ERC8004Client;
  erc8004TokenId?: number;
  evmWallet?: EvmWallet;
  vaultKeyManager?: VaultKeyManager;
  config?: ProtocolConfig;
  signer?: (data: Uint8Array) => Promise<Uint8Array>;
  domain?: string;
  pendingSuccessionSession?: KeyExchangeSession;
  snapshotManager?: SnapshotManager;
  onAdmissionComplete?: () => void;
  onSuccessionComplete?: () => void;
}

export async function handleStatus(deps: HandlerDeps): Promise<StatusResponse> {
  const healthResult = await deps.healthAdapter.check();
  const state = deps.stateAdapter.getState();
  return {
    role: deps.role,
    teeInstanceId: deps.teeInstanceId,
    healthy: healthResult.healthy,
    uptime: Date.now() - deps.startTime,
    recoveryCount: state.recoveryCount,
  };
}

export async function handlePing(
  deps: HandlerDeps,
  body: unknown,
): Promise<{ ok: boolean; timestamp?: number; error?: string }> {
  if (!deps.heartbeatManager) {
    return { ok: true, timestamp: Date.now() };
  }

  const envelope = body as Record<string, unknown>;
  if (!envelope || !envelope.teeInstanceId || !envelope.timestamp || !envelope.nonce || !envelope.signature) {
    return { ok: false, error: 'missing required ping envelope fields' };
  }

  // In DEV_MODE, skip signature verification but still track the ping
  if (process.env.DEV_MODE === 'true') {
    deps.heartbeatManager.onPingReceived();
    return { ok: true, timestamp: Date.now() };
  }

  // TODO: Phase 8+ — verify ping envelope signature against stored peer public key
  deps.heartbeatManager.onPingReceived();
  return { ok: true, timestamp: Date.now() };
}

export async function handleAdmission(
  deps: HandlerDeps,
  body: unknown,
  sourceIp: string = '',
): Promise<AdmissionResult> {
  if (!deps.admissionService) {
    return { accepted: false, reason: 'admission_service_not_initialized' };
  }

  const req = body as Record<string, unknown>;
  if (!req || !req.role || !req.networkAddress || !req.teeInstanceId || !req.nonce) {
    return { accepted: false, reason: 'invalid_request' };
  }

  // Resolve domain: prefer request-supplied domain, fall back to source IP
  const resolvedDomain = (req.domain && req.domain !== 'localhost')
    ? req.domain as string
    : sourceIp;

  // Deserialize Uint8Array fields from base64 if they come as strings
  const admissionReq: AdmissionRequest = {
    role: req.role as 'guardian' | 'backup_agent',
    networkAddress: req.networkAddress as string,
    teeInstanceId: req.teeInstanceId as string,
    rtmr3: (req.rtmr3 as string) ?? undefined,
    domain: resolvedDomain || undefined,
    x25519PublicKey: deserializeKey(req.x25519PublicKey),
    ed25519PublicKey: deserializeKey(req.ed25519PublicKey),
    ed25519Signature: deserializeKey(req.ed25519Signature),
    nonce: req.nonce as string,
    timestamp: (req.timestamp as number) ?? Date.now(),
  };

  // If guardian sent 'source-ip' sentinel, replace with actual source IP
  if (admissionReq.role === 'guardian' &&
      admissionReq.networkAddress.includes('source-ip')) {
    admissionReq.networkAddress =
      admissionReq.networkAddress.replace('source-ip', sourceIp);
    console.log(
      `[admission] resolved guardian network address to ${admissionReq.networkAddress}`
    );
  }

  const result = await deps.admissionService.handleAdmissionRequest(admissionReq);
  if (result.accepted) {
    deps.onAdmissionComplete?.();
  }
  return result;
}

export async function handleEvmAddress(
  deps: HandlerDeps,
): Promise<{ address: string | null }> {
  return { address: deps.evmAddress ?? null };
}

export async function handleWorkload(
  deps: HandlerDeps,
): Promise<{ handle: string; displayName: string }> {
  const state = deps.stateAdapter.getState();
  return { handle: state.agentHandle, displayName: state.displayName };
}

export async function handleDiscover(
  deps: HandlerDeps,
): Promise<{ teeInstanceId: string; role: string; networkAddress: string; rtmr3: string; timestamp: number }> {
  return {
    teeInstanceId: deps.teeInstanceId,
    role: deps.role,
    networkAddress: `http://localhost:${process.env.PORT ?? '3001'}`,
    rtmr3: deps.agentRtmr3 ?? 'dev-measurement',
    timestamp: Date.now(),
  };
}

export async function handleBackupReady(
  deps: HandlerDeps,
  body: unknown,
): Promise<Record<string, unknown>> {
  const ownRtmr3 = deps.agentRtmr3 ?? 'dev-measurement';

  // Generate session inline so we can store it for use in handleBackupConfirm
  const session = await KeyExchangeSession.generate();
  const keys = session.getPublicKeys();
  deps.pendingSuccessionSession = session;

  // Serialize Uint8Array fields to base64 for JSON transport
  return {
    rtmr3: ownRtmr3,
    x25519PublicKey: Buffer.from(keys.x25519).toString('base64'),
    ed25519PublicKey: Buffer.from(keys.ed25519).toString('base64'),
    ed25519Signature: Buffer.from(keys.signature).toString('base64'),
  };
}

export async function handleBackupConfirm(
  deps: HandlerDeps,
  body: unknown,
): Promise<{ ok: boolean }> {
  if (!deps.db) {
    return { ok: false };
  }

  // Unwrap vault key and apply snapshot from guardian
  const req = body as Record<string, unknown>;
  if (req.encryptedVaultKey && req.dbSnapshot && deps.pendingSuccessionSession) {
    const guardianX25519 = deserializeKey(req.guardianX25519PublicKey);
    if (guardianX25519.length > 0) {
      const sharedSecret = deps.pendingSuccessionSession.computeSharedSecret(guardianX25519);
      const receivedVaultKey = deps.pendingSuccessionSession.unwrapVaultKey(
        req.encryptedVaultKey as WrappedKey,
        sharedSecret,
      );

      // Update vault key FIRST — needed before snapshot can be decrypted
      if (deps.vaultKeyManager) {
        deps.vaultKeyManager.replaceKey(receivedVaultKey);
        await deps.vaultKeyManager.seal();
        console.log('[agent] vault key received and sealed');
      }

      // Apply snapshot with the RECEIVED vault key (not backup's old random key)
      if (deps.db) {
        const snapshotMgr = new SnapshotManager(deps.db, receivedVaultKey, deps.teeInstanceId);
        await snapshotMgr.applySnapshot(req.dbSnapshot as DbSnapshot);
        deps.snapshotManager = snapshotMgr;
        console.log('[agent] DB snapshot applied from guardian');
      }

      deps.pendingSuccessionSession = undefined;
    }
  }

  // Re-initialize EVM wallet from the now-populated DB
  if (!deps.evmWallet && deps.db) {
    const mnemonic = deps.db.getConfig('evm_mnemonic');
    if (mnemonic) {
      const { mnemonicToAccount } = await import('viem/accounts');
      const account = mnemonicToAccount(mnemonic);
      deps.evmWallet = {
        address: account.address,
        account,
        signTransaction: async (tx: unknown) => account.signTransaction(tx as any),
      };
      deps.evmAddress = account.address;
      console.log(`[agent] EVM wallet restored from DB: ${account.address}`);
    }
  }

  // Restore ERC-8004 client and token ID from DB
  if (deps.db && !deps.erc8004TokenId) {
    const storedTokenId = deps.db.getConfig('erc8004_token_id');
    if (storedTokenId) {
      deps.erc8004TokenId = parseInt(storedTokenId, 10);
      console.log(`[agent] ERC-8004 token ID restored: ${storedTokenId}`);
    }
  }

  if (!deps.erc8004Client && deps.config) {
    const { ERC8004Client } = await import('@idiostasis/erc8004-client');
    const baseRpcUrl = process.env.BASE_RPC_URL ?? '';
    const registryAddress = process.env.ERC8004_REGISTRY_ADDRESS
      ?? '0x8004A818BFB912233c491871b3d84c89A494BD9e';
    deps.erc8004Client = new ERC8004Client(
      baseRpcUrl,
      registryAddress,
      (process.env.BASE_NETWORK ?? 'base-sepolia') as 'base-sepolia' | 'base',
    );
  }

  deps.db.logEvent(ProtocolEventType.SUCCESSION_COMPLETE);
  console.log('[agent] Succession confirmed — rotating vault key');

  // Rotate vault key (Decision 6)
  if (deps.vaultKeyManager && deps.signer) {
    try {
      const guardians = deps.db.listGuardians('active');
      const oldVaultKey = deps.vaultKeyManager.getKey();

      const keyExchangeFn = async (guardian: { teeInstanceId: string; }) => {
        // Look up guardian's stored X25519 public key
        const peerKeys = deps.db!.getPeerPublicKey(guardian.teeInstanceId);
        const session = await KeyExchangeSession.generate();
        if (peerKeys?.x25519) {
          const sharedSecret = session.computeSharedSecret(peerKeys.x25519);
          return { session, sharedSecret };
        }
        // No stored X25519 key — generate dummy shared secret (guardian will need re-admission)
        console.warn(`[agent] No X25519 key for guardian ${guardian.teeInstanceId} — skipping`);
        throw new Error('no_x25519_key');
      };

      // Transport: POST wrapped key to guardian's /api/vault-key-update
      const transport: VaultKeyTransport = async (guardian, wrappedKey, snapshot, primaryX25519PublicKey) => {
        try {
          const url = guardian.networkAddress.startsWith('http')
            ? `${guardian.networkAddress}/api/vault-key-update`
            : `http://${guardian.networkAddress}/api/vault-key-update`;
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              wrappedKey,
              snapshot,
              primaryX25519PublicKey: Buffer.from(primaryX25519PublicKey).toString('base64'),
            }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) return false;
          const json = await res.json() as { ok: boolean };
          return json.ok === true;
        } catch {
          return false;
        }
      };

      await rotateVaultKey(
        deps.db,
        oldVaultKey,
        deps.vaultKeyManager,
        guardians,
        keyExchangeFn,
        transport,
        deps.signer,
        deps.teeInstanceId,
      );
      console.log('[agent] Vault key rotated successfully');
    } catch (err) {
      console.error(`[agent] Vault key rotation failed: ${err}`);
    }
  }

  // Update ERC-8004 registry endpoints after succession
  console.log(`[agent] ERC-8004 update: client=${!!deps.erc8004Client} tokenId=${deps.erc8004TokenId} wallet=${!!deps.evmWallet} domain=${deps.domain}`);
  if (deps.erc8004Client && deps.erc8004TokenId && deps.evmWallet) {
    try {
      const port = process.env.PORT ?? '3001';
      const domain = deps.domain && deps.domain !== 'localhost'
        ? deps.domain : 'localhost';

      await deps.erc8004Client.updateAllEndpoints(
        deps.erc8004TokenId,
        [
          { name: 'discovery', endpoint: `http://${domain}:${port}/discover` },
          { name: 'workload', endpoint: `http://${domain}:${port}/workload` },
          { name: 'teequote', endpoint: `https://${domain}:29343/cpu.html` },
        ],
        deps.evmWallet,
      );
      console.log(`[agent] ERC-8004 all endpoints updated to ${domain} — succession complete`);
    } catch (err) {
      console.warn(`[agent] ERC-8004 endpoint update failed (non-fatal): ${err}`);
    }
  }

  deps.role = 'primary';
  console.log('[agent] role updated to primary');
  console.log('[agent] Succession complete — now primary');

  // Store compose files for autonomous provisioning
  void (async () => {
    if (!deps.db) return;
    try {
      const guardianUrl = process.env.GUARDIAN_COMPOSE_URL
        ?? 'https://raw.githubusercontent.com/MrGarbonzo/idiostasis-protocol/main/docker/docker-compose.secretvm-guardian.yml';
      const agentUrl = process.env.AGENT_COMPOSE_URL
        ?? 'https://raw.githubusercontent.com/MrGarbonzo/idiostasis-protocol/main/docker/docker-compose.secretvm-agent.yml';
      const [gr, ar] = await Promise.all([
        fetch(guardianUrl, { signal: AbortSignal.timeout(15_000) }),
        fetch(agentUrl, { signal: AbortSignal.timeout(15_000) }),
      ]);
      if (gr.ok) deps.db.setConfig('guardian_compose', await gr.text());
      if (ar.ok) deps.db.setConfig('agent_compose', await ar.text());
      console.log('[agent] compose files stored post-succession');
    } catch (err) {
      console.warn('[agent] failed to store compose files post-succession:', err);
    }
  })();

  deps.onSuccessionComplete?.();
  return { ok: true };
}

export async function handleNetworkStatus(
  deps: HandlerDeps,
): Promise<Record<string, unknown>> {
  if (!deps.db) {
    return { guardians: 0, backups: 0, guardianDetails: [], backupDetails: [] };
  }

  const guardians = deps.db.listGuardians('active');
  const backups = deps.db.listBackupAgents('standby');

  return {
    agent: {
      teeInstanceId: deps.teeInstanceId,
      role: deps.role,
      domain: deps.domain ?? 'unknown',
    },
    network: {
      guardians: guardians.length,
      backups: backups.length,
    },
    guardianDetails: guardians.map(g => ({
      teeInstanceId: g.teeInstanceId.slice(0, 8),
      provisionedBy: g.provisionedBy,
      lastSeenAgo: `${Math.round((Date.now() - new Date(g.lastSeenAt).getTime()) / 1000)}s ago`,
    })),
    backupDetails: backups.map(b => ({
      teeInstanceId: b.teeInstanceId.slice(0, 8),
      heartbeatStreak: b.heartbeatStreak,
      lastHeartbeatAgo: `${Math.round((Date.now() - new Date(b.lastHeartbeatAt).getTime()) / 1000)}s ago`,
    })),
    timestamp: new Date().toISOString(),
  };
}

function deserializeKey(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value);
  if (typeof value === 'string') return new Uint8Array(Buffer.from(value, 'base64'));
  return new Uint8Array(0);
}
