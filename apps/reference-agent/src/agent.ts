import { join } from 'node:path';
import { randomUUID, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import {
  loadConfig,
  VaultKeyManager,
  ProtocolDatabase,
  SnapshotManager,
  AdmissionService,
  HeartbeatManager,
  KeyExchangeSession,
  resolveTeeInstanceId,
  resolveSecretvmDomain,
  resolveSecretvmDomainFromTls,
  SecretLabsAttestationProvider,
  generateAgentMnemonic,
  CONFIG_KEYS,
} from '@idiostasis/core';
import type { ProtocolConfig, PingTransport, PingSigner } from '@idiostasis/core';
import {
  ERC8004Client,
  ERC8004_REGISTRY_ADDRESS_BASE_SEPOLIA,
} from '@idiostasis/erc8004-client';
import type { EvmWallet } from '@idiostasis/erc8004-client';
import { mnemonicToAccount } from 'viem/accounts';
import {
  X402Client,
  SecretVmClient,
} from '@idiostasis/x402-client';
import type { EvmSigningWallet } from '@idiostasis/x402-client';
import { AutonomousGuardianManager } from '@idiostasis/guardian';
import { MoltbookStateAdapter } from './state/adapter.js';
import { MoltbookHealthAdapter } from './health/adapter.js';
import { MoltbookClient } from './moltbook/client.js';
import { HttpServer } from './http/server.js';
import type { HandlerDeps } from './http/handlers.js';

export class MoltbookAgent {
  private config: ProtocolConfig;
  private stateAdapter: MoltbookStateAdapter | null = null;
  private healthAdapter: MoltbookHealthAdapter | null = null;
  private httpServer: HttpServer | null = null;
  private db: ProtocolDatabase | null = null;
  private vaultKeyManager: VaultKeyManager | null = null;
  private teeInstanceId: string = '';
  private domain: string = '';
  private role: string = 'unknown';
  private startTime: number = Date.now();
  private admissionService: AdmissionService | null = null;
  private heartbeatManager: HeartbeatManager | null = null;
  private snapshotManager: SnapshotManager | null = null;
  private agentRtmr3: string = '';
  private erc8004Client: ERC8004Client | null = null;
  private erc8004TokenId: number | null = null;
  private evmWallet: EvmWallet | null = null;
  private x402Client: X402Client | null = null;
  private secretvmClient: SecretVmClient | null = null;
  private guardianManager: AutonomousGuardianManager | null = null;
  private primaryBaseUrl: string = '';

  constructor() {
    this.config = loadConfig();
  }

  async initialize(): Promise<void> {
    // 1. Load vault key
    this.vaultKeyManager = await VaultKeyManager.load();
    const vaultKey = this.vaultKeyManager.getKey();

    // 2. Resolve TEE identity and domain
    this.teeInstanceId = await resolveTeeInstanceId();
    this.domain = await resolveSecretvmDomain();
    console.log(`[agent] domain: ${this.domain}`);

    // 3. Determine role via ERC-8004 registry check
    this.role = await this.resolveRole();

    // 4. Initialize DB
    const dbPath = process.env.DB_PATH ?? join('/data', 'agent.db');
    this.db = new ProtocolDatabase(dbPath, vaultKey);

    // 5. Initialize state adapter
    const handle = process.env.MOLTBOOK_HANDLE ?? 'testagent';
    const displayName = process.env.MOLTBOOK_DISPLAY_NAME ?? 'Idiostasis Agent';
    this.stateAdapter = new MoltbookStateAdapter(handle, displayName);

    // Try to load persisted state from DB
    const persisted = this.db.getAgentState();
    if (persisted) {
      await this.stateAdapter.deserialize(persisted);
      console.log('[agent] loaded persisted state');
    } else {
      console.log('[agent] no persisted state — using initial state');
    }

    // 6. Initialize Moltbook client + health adapter
    const moltbookUrl = process.env.MOLTBOOK_API_URL ?? 'https://moltbook.example.com';
    const moltbookClient = new MoltbookClient(moltbookUrl);
    this.healthAdapter = new MoltbookHealthAdapter(this.stateAdapter, moltbookClient);

    // 7. Initialize RTMR3
    // Priority: env var override → persisted DB value → self-attest via PCCS → dev fallback
    this.agentRtmr3 = process.env.AGENT_RTMR3
      ?? this.db.getConfig('agent_rtmr3')
      ?? await (async () => {
        if (process.env.DEV_MODE === 'true') return 'dev-measurement';
        try {
          const provider = new SecretLabsAttestationProvider(this.config.pccsEndpoints);
          const quote = await provider.fetchQuote('172.17.0.1');
          const result = await provider.verifyQuote(quote);
          console.log(`[agent] self-attested RTMR3: ${result.rtmr3.slice(0, 16)}...`);
          return result.rtmr3;
        } catch (err) {
          console.warn(`[agent] self-attestation failed, using dev fallback: ${err}`);
          return 'dev-measurement';
        }
      })();

    // 7b. Resolve domain for ERC-8004 — try TLS cert on port 29343 (primary only)
    if (this.role === 'primary' && this.domain === 'localhost') {
      const tlsDomain = await resolveSecretvmDomainFromTls();
      if (tlsDomain) {
        this.domain = tlsDomain;
        console.log(`[agent] domain resolved from TLS: ${this.domain}`);
      }
    }

    const guardianRtmr3 = (process.env.GUARDIAN_APPROVED_RTMR3 ?? '')
      .split(',').map(s => s.trim()).filter(Boolean);

    // 8. Initialize SnapshotManager
    this.snapshotManager = new SnapshotManager(this.db, vaultKey, this.teeInstanceId);

    // 9. Initialize signer (dev fallback pattern from vault/exchange.ts)
    const signer = createSigner();

    // 10. Initialize AdmissionService
    const attestationProvider = process.env.DEV_MODE === 'true'
      ? undefined
      : new SecretLabsAttestationProvider(this.config.pccsEndpoints);

    this.admissionService = new AdmissionService(
      this.db,
      {
        ...this.config,
        agentApprovedRtmr3: [this.agentRtmr3],
        guardianApprovedRtmr3: guardianRtmr3,
      },
      vaultKey,
      this.snapshotManager,
      signer,
      attestationProvider,
    );

    // 11. Initialize HeartbeatManager (primary role)
    this.heartbeatManager = new HeartbeatManager(this.config, this.db, 'primary');

    // 12. Initialize ERC-8004 client
    const baseRpcUrl = process.env.BASE_RPC_URL ?? '';
    const registryAddress = process.env.ERC8004_REGISTRY_ADDRESS
      ?? ERC8004_REGISTRY_ADDRESS_BASE_SEPOLIA;
    this.erc8004Client = new ERC8004Client(
      baseRpcUrl,
      registryAddress,
      (process.env.BASE_NETWORK ?? 'base-sepolia') as 'base-sepolia' | 'base',
    );

    // 13. ERC-8004 registration on first boot (primary only)
    let evmMnemonic: string | null = null;
    if (this.role === 'primary') {
      try {
        const resolved = await resolveEvmWallet(this.db);
        if (resolved) {
          this.evmWallet = resolved.wallet;
          evmMnemonic = resolved.mnemonic;
        }
      } catch (err) {
        console.warn(`[agent] EVM wallet setup failed (non-fatal): ${err}`);
      }

      const storedTokenId = this.db.getConfig('erc8004_token_id');
      if (!storedTokenId && this.evmWallet && baseRpcUrl && this.domain !== 'localhost') {
        try {
          const port = process.env.PORT ?? '3001';
          const result = await this.erc8004Client.register({
            name: process.env.MOLTBOOK_HANDLE ?? 'testagent',
            description: 'Idiostasis Protocol reference agent',
            services: [
              { name: 'teequote', endpoint: `https://${this.domain}:29343/cpu.html` },
              { name: 'workload', endpoint: `http://${this.domain}:${port}/workload` },
              { name: 'discovery', endpoint: `http://${this.domain}:${port}/discover` },
            ],
            image: process.env.AGENT_IMAGE_URL,
            wallet: this.evmWallet,
          });
          this.erc8004TokenId = result.tokenId;
          this.db.setConfig('erc8004_token_id', String(result.tokenId));
          this.db.setConfig('erc8004_domain', this.domain);
          console.log(`[agent] ERC-8004 registered. Token ID: ${result.tokenId}`);
        } catch (err) {
          console.warn(`[agent] ERC-8004 registration failed (non-fatal): ${err}`);
        }
      } else if (storedTokenId) {
        this.erc8004TokenId = parseInt(storedTokenId, 10);
        const storedDomain = this.db.getConfig('erc8004_domain');
        console.log(`[agent] ERC-8004 token ID: ${storedTokenId}, domain: ${storedDomain}`);
      }
    }

    // 14. Initialize x402 and SecretVM clients
    if (this.evmWallet && evmMnemonic) {
      const mnemonic = evmMnemonic;
      const x402Wallet = {
        address: this.evmWallet.address,
        signMessage: async (message: string | Uint8Array) => {
          const account = mnemonicToAccount(mnemonic);
          if (message instanceof Uint8Array) {
            return account.signMessage({ message: { raw: message } });
          }
          return account.signMessage({ message });
        },
        signTypedData: async (params: Record<string, unknown>) => {
          const account = mnemonicToAccount(mnemonic);
          return account.signTypedData(params as any);
        },
      };
      this.x402Client = new X402Client(
        x402Wallet,
        process.env.X402_FACILITATOR_URL,
      );

      const evmSigningWallet: EvmSigningWallet = {
        address: this.evmWallet.address,
        signMessage: (message: string | Uint8Array) => x402Wallet.signMessage(message),
      };
      this.secretvmClient = new SecretVmClient(evmSigningWallet, this.x402Client);

      console.log('[agent] x402 (Base/EVM) and SecretVM clients initialized');
    } else if (!this.evmWallet) {
      console.warn('[agent] No EVM credentials — x402 and SecretVM disabled');
    }

    const deps: HandlerDeps = {
      stateAdapter: this.stateAdapter,
      healthAdapter: this.healthAdapter,
      teeInstanceId: this.teeInstanceId,
      role: this.role,
      startTime: this.startTime,
      admissionService: this.admissionService,
      heartbeatManager: this.heartbeatManager,
      db: this.db,
      agentRtmr3: this.agentRtmr3,
      evmAddress: this.evmWallet?.address,
      erc8004Client: this.erc8004Client,
      erc8004TokenId: this.erc8004TokenId ?? undefined,
      evmWallet: this.evmWallet ?? undefined,
      vaultKeyManager: this.vaultKeyManager ?? undefined,
      config: this.config,
      signer,
      domain: this.domain,
      snapshotManager: this.snapshotManager ?? undefined,
      onAdmissionComplete: () => {
        void this.pushSnapshotToGuardians();
      },
      onSuccessionComplete: () => {
        if (this.secretvmClient && this.db) {
          this.startGuardianManager();
        }
      },
    };
    this.httpServer = new HttpServer(deps);

    // 16. Seal vault key
    await this.vaultKeyManager.seal();

    console.log(`[agent] initialized, teeInstanceId=${this.teeInstanceId}, role=${this.role}`);
  }

  async start(): Promise<void> {
    const port = parseInt(process.env.PORT ?? '3001', 10);
    await this.httpServer!.start(port);

    // Persist initial state
    await this.persistState();

    // Start heartbeat manager with transport + signer
    const transport = createPingTransport();
    const signer = createSigner();
    this.heartbeatManager!.start({
      transport,
      signer,
      teeInstanceId: this.teeInstanceId,
    });
    console.log('[agent] Heartbeat manager started');

    // Periodic DB snapshot push to guardians (every 5 minutes)
    setInterval(() => {
      void this.pushSnapshotToGuardians();
    }, 5 * 60 * 1000);
    console.log('[agent] periodic snapshot push started (5min interval)');

    // Backup agent: initiate admission to primary, skip guardian manager / ERC-8004
    if (this.role === 'backup') {
      this.initiateBackupAdmission().catch(err =>
        console.error('[agent] backup admission error:', err)
      );
      return;
    }

    // Start autonomous guardian manager (primary only)
    if (this.role === 'primary' && this.secretvmClient && this.db) {
      this.startGuardianManager();
    } else if (this.role === 'primary') {
      console.warn(
        '[agent] Autonomous guardian manager disabled — ' +
        'no SecretVM client',
      );
    }

    console.log(`[agent] started as ${this.role}`);
    console.log('[agent] TODO: Phase 11 — snapshot push loop, re-attestation loop');
    console.log('[agent] TODO: Phase 11 — Moltbook registration and posting loop');
  }

  async persistState(): Promise<void> {
    if (!this.stateAdapter || !this.db) return;
    const data = await this.stateAdapter.serialize();
    this.db.setAgentState(data);
  }

  async shutdown(): Promise<void> {
    console.log('[agent] shutting down...');
    this.heartbeatManager?.stop();
    await this.persistState();
    await this.httpServer?.stop();
    this.db?.close();
    console.log('[agent] shutdown complete');
  }

  private startGuardianManager(): void {
    if (!this.db) return;

    // Initialize x402/SecretVM if not already done (post-succession path)
    void this.initX402AndSecretVM().then(() => {
      if (!this.secretvmClient) {
        console.warn('[agent] Autonomous guardian manager disabled — no SecretVM client');
        return;
      }

      const guardianVmClient = {
        createVm: async (params: { name: string; dockerCompose: Uint8Array }) => {
          const result = await this.secretvmClient!.createVm({
            name: params.name,
            vmTypeId: 'standard',
            dockerComposeYaml: new TextDecoder().decode(params.dockerCompose),
            fsPersistence: true,
          });
          return { vmId: result.vmId, domain: result.vmDomain };
        },
        getVmStatus: async (vmId: string) => {
          const status = await this.secretvmClient!.getVmStatus(vmId);
          return { status: status.status };
        },
        stopVm: (vmId: string) => this.secretvmClient!.stopVm(vmId),
      };

      this.guardianManager = new AutonomousGuardianManager(
        this.db!,
        this.config,
        guardianVmClient,
      );

      void this.guardianManager.evaluate().catch(err =>
        console.error('[guardian-manager] initial evaluate() error:', err)
      );
      setInterval(
        () => this.guardianManager!.evaluate().catch(err =>
          console.error('[guardian-manager] evaluate() error:', err)
        ),
        this.config.heartbeatIntervalMs,
      );
      console.log('[agent] Autonomous guardian manager started');
    });
  }

  private async initX402AndSecretVM(): Promise<void> {
    if (this.x402Client && this.secretvmClient) return;
    if (!this.db) return;

    const mnemonic = this.db.getConfig('evm_mnemonic');
    if (!mnemonic) return;

    const { mnemonicToAccount } = await import('viem/accounts');
    const account = mnemonicToAccount(mnemonic);

    const x402Wallet = {
      address: account.address,
      signMessage: async (message: string | Uint8Array) => {
        if (message instanceof Uint8Array) {
          return account.signMessage({ message: { raw: message } });
        }
        return account.signMessage({ message });
      },
      signTypedData: async (params: Record<string, unknown>) => {
        return account.signTypedData(params as any);
      },
    };

    this.x402Client = new X402Client(
      x402Wallet,
      process.env.X402_FACILITATOR_URL,
    );

    const evmSigningWallet: EvmSigningWallet = {
      address: account.address,
      signMessage: (message: string | Uint8Array) => x402Wallet.signMessage(message),
    };

    this.secretvmClient = new SecretVmClient(evmSigningWallet, this.x402Client);
    console.log('[agent] x402 and SecretVM clients initialized post-succession');
  }

  private async resolveRole(): Promise<string> {
    const tokenId = parseInt(process.env.ERC8004_TOKEN_ID ?? '0', 10);
    const baseRpcUrl = process.env.BASE_RPC_URL ?? '';

    if (!tokenId || !baseRpcUrl) {
      console.log('[agent] no ERC8004_TOKEN_ID — booting as primary');
      return 'primary';
    }

    const registryAddress = process.env.ERC8004_REGISTRY_ADDRESS
      ?? ERC8004_REGISTRY_ADDRESS_BASE_SEPOLIA;
    const client = new ERC8004Client(
      baseRpcUrl,
      registryAddress,
      (process.env.BASE_NETWORK ?? 'base-sepolia') as 'base-sepolia' | 'base',
    );

    try {
      const discovered = await client.getLivePrimaryAddress(tokenId);
      if (!discovered) {
        console.log('[agent] no live primary in registry — booting as primary');
        return 'primary';
      }

      // Extract base URL from discovery endpoint
      const url = new URL(discovered);
      const primaryBaseUrl = `${url.protocol}//${url.host}`;

      // Check if the live primary is reachable and not this instance
      try {
        const res = await fetch(`${primaryBaseUrl}/status`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) {
          const status = await res.json() as { teeInstanceId?: string };
          if (status.teeInstanceId === this.teeInstanceId) {
            console.log('[agent] registry points to this instance — booting as primary');
            return 'primary';
          }
          console.log(`[agent] live primary found at ${primaryBaseUrl} — booting as backup`);
          this.primaryBaseUrl = primaryBaseUrl;
          return 'backup';
        }
      } catch {
        console.log('[agent] registry primary unreachable — booting as primary');
        return 'primary';
      }
    } catch (err) {
      console.warn(`[agent] registry check failed: ${err} — booting as primary`);
    }

    return 'primary';
  }

  private async pushSnapshotToGuardians(): Promise<void> {
    if (!this.db || !this.snapshotManager || !this.admissionService) return;
    const guardians = this.db.listGuardians('active');
    if (guardians.length === 0) return;

    const signer = createSigner();
    const snapshot = await this.snapshotManager.createSnapshot(signer);

    for (const guardian of guardians) {
      try {
        const url = guardian.networkAddress.startsWith('http')
          ? `${guardian.networkAddress}/recovery`
          : `http://${guardian.networkAddress}/recovery`;

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ snapshot }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          console.log(`[agent] snapshot pushed to guardian ${guardian.teeInstanceId.slice(0, 8)}`);
        }
      } catch (err) {
        console.warn(`[agent] snapshot push to guardian ${guardian.id} failed: ${err}`);
      }
    }
  }

  private async initiateBackupAdmission(): Promise<void> {
    console.log(`[agent] initiating backup admission to ${this.primaryBaseUrl}`);

    let attempts = 0;
    const maxAttempts = 10;
    const retryDelayMs = 15_000;

    while (attempts < maxAttempts) {
      attempts++;

      const session = await KeyExchangeSession.generate();
      const { x25519, ed25519, signature } = session.getPublicKeys();
      const nonce = randomUUID();
      const timestamp = Date.now();
      const port = process.env.PORT ?? '3001';

      const body = JSON.stringify({
        role: 'backup_agent',
        networkAddress: `http://${this.domain}:${port}`,
        teeInstanceId: this.teeInstanceId,
        nonce,
        timestamp,
        x25519PublicKey: Array.from(x25519),
        ed25519PublicKey: Array.from(ed25519),
        ed25519Signature: Array.from(signature),
      });

      try {
        const res = await fetch(`${this.primaryBaseUrl}/api/admission`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(10_000),
        });

        const result = await res.json() as {
          accepted: boolean;
          reason?: string;
        };

        if (result.accepted) {
          console.log('[agent] backup admission accepted — standing by for succession');
          return;
        }

        console.warn(
          `[agent] backup admission rejected: ${result.reason} ` +
          `(attempt ${attempts}/${maxAttempts})`
        );

        if (result.reason === 'rtmr3_mismatch' ||
            result.reason === 'invalid_signature') {
          console.error('[agent] backup admission hard-rejected — fix configuration');
          return;
        }
      } catch (err) {
        console.warn(`[agent] backup admission attempt ${attempts}/${maxAttempts} failed: ${err}`);
      }

      if (attempts < maxAttempts) {
        await new Promise(r => setTimeout(r, retryDelayMs));
      }
    }

    console.error('[agent] backup admission failed after all attempts');
  }
}

/**
 * Create a ping transport: HTTP POST to participant's /ping endpoint.
 */
function createPingTransport(): PingTransport {
  return async (networkAddress: string, envelope) => {
    try {
      const url = networkAddress.startsWith('http')
        ? `${networkAddress}/ping`
        : `http://${networkAddress}/ping`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return false;
      const json = await res.json() as { ok: boolean };
      return json.ok === true;
    } catch {
      return false;
    }
  };
}

/**
 * Create a signer for ping envelopes and snapshots.
 * Production: POST to TEE signing service.
 * Dev fallback: ephemeral Ed25519 keypair.
 */
function createSigner(): PingSigner {
  if (process.env.DEV_MODE !== 'true') {
    // Try production signer, fall back to dev
    return async (data: Uint8Array) => {
      try {
        const res = await fetch('http://172.17.0.1:49153/sign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            key_type: 'ed25519',
            payload: Buffer.from(data).toString('base64'),
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`signing service returned ${res.status}`);
        const json = await res.json() as { signature: string };
        return new Uint8Array(Buffer.from(json.signature, 'base64'));
      } catch {
        return devSign(data);
      }
    };
  }
  return async (data: Uint8Array) => devSign(data);
}

// Persistent dev keypair for the lifetime of the process
let devKeyPair: { publicKey: KeyObject; privateKey: KeyObject } | null = null;

function devSign(data: Uint8Array): Uint8Array {
  if (!devKeyPair) {
    devKeyPair = generateKeyPairSync('ed25519');
    console.warn('[agent] using ephemeral ed25519 keypair — DEV MODE ONLY');
  }
  return new Uint8Array(sign(null, data, devKeyPair.privateKey));
}

/**
 * Resolve EVM wallet from BIP39 mnemonic.
 * Priority: DB → env var (EVM_MNEMONIC) → legacy env var (EVM_PRIVATE_KEY) → TEE generation.
 * Mnemonic is stored encrypted in the DB (protected by vault key).
 * Survives succession via DB snapshot — same mnemonic = same address.
 *
 * IMPORTANT: Set EVM_MNEMONIC in usr/.env to preserve wallet
 * identity across VM redeployments. Without it, each new VM
 * generates a fresh mnemonic, orphaning the ERC-8004 token.
 * Get the mnemonic from the DB on the current VM before
 * redeploying:
 *   docker exec idiostasis-agent node --input-type=module -e \
 *   "import Database from 'better-sqlite3'; \
 *    const db = new Database('/data/agent.db'); \
 *    console.log(db.prepare(\"SELECT value FROM config WHERE key='evm_mnemonic'\").get()?.value);"
 */
async function resolveEvmWallet(db: ProtocolDatabase): Promise<{ wallet: EvmWallet; mnemonic: string } | null> {
  // 1. Load mnemonic from DB (set on any previous boot)
  let mnemonic = db.getConfig(CONFIG_KEYS.EVM_MNEMONIC);

  if (!mnemonic) {
    // 2. Env var override (dev mode or manual bootstrap)
    if (process.env.EVM_MNEMONIC) {
      mnemonic = process.env.EVM_MNEMONIC;
      db.setConfig(CONFIG_KEYS.EVM_MNEMONIC, mnemonic);

    // 3. Legacy: raw private key env var (migration path)
    } else if (process.env.EVM_PRIVATE_KEY) {
      console.warn('[agent] EVM_PRIVATE_KEY is deprecated — generating mnemonic instead');
      mnemonic = generateAgentMnemonic();
      db.setConfig(CONFIG_KEYS.EVM_MNEMONIC, mnemonic);

    // 4. Generate new mnemonic in TEE on first boot
    } else if (process.env.DEV_MODE !== 'true') {
      mnemonic = generateAgentMnemonic();
      db.setConfig(CONFIG_KEYS.EVM_MNEMONIC, mnemonic);

    } else {
      // DEV_MODE with no credentials — EVM features disabled
      console.warn('[agent] No EVM credentials — EVM features disabled');
      return null;
    }
  }

  // Derive account from mnemonic using standard derivation path
  const account = mnemonicToAccount(mnemonic);
  console.log(`[agent] EVM wallet: ${account.address}`);

  const wallet: EvmWallet = {
    address: account.address,
    account,
    signTransaction: async (tx: unknown) => account.signTransaction(tx as any),
  };

  return { wallet, mnemonic };
}
