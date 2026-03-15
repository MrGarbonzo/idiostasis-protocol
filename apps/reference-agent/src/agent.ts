import { join } from 'node:path';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import {
  loadConfig,
  VaultKeyManager,
  ProtocolDatabase,
  SnapshotManager,
  AdmissionService,
  HeartbeatManager,
  resolveTeeInstanceId,
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
  private role: string = 'unknown';
  private startTime: number = Date.now();
  private admissionService: AdmissionService | null = null;
  private heartbeatManager: HeartbeatManager | null = null;
  private snapshotManager: SnapshotManager | null = null;
  private agentRtmr3: string = 'dev-measurement';
  private erc8004Client: ERC8004Client | null = null;
  private erc8004TokenId: number | null = null;
  private evmWallet: EvmWallet | null = null;
  private x402Client: X402Client | null = null;
  private secretvmClient: SecretVmClient | null = null;
  private guardianManager: AutonomousGuardianManager | null = null;

  constructor() {
    this.config = loadConfig();
  }

  async initialize(): Promise<void> {
    // 1. Load vault key
    this.vaultKeyManager = await VaultKeyManager.load();
    const vaultKey = this.vaultKeyManager.getKey();

    // 2. Resolve TEE identity
    this.teeInstanceId = await resolveTeeInstanceId();

    // 3. Determine role
    this.role = this.vaultKeyManager.isFirstBoot() ? 'primary' : 'primary';
    // TODO: Phase 10 — role resolution from DB state (primary vs backup)

    // 4. Initialize DB
    const dbPath = process.env.DB_PATH ?? join('/data', 'agent.db');
    this.db = new ProtocolDatabase(dbPath, vaultKey);

    // 5. Initialize state adapter
    const handle = process.env.MOLTBOOK_HANDLE ?? 'agent';
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
    this.agentRtmr3 = process.env.AGENT_RTMR3
      ?? this.db.getConfig('agent_rtmr3')
      ?? 'dev-measurement';

    if (!this.db.getConfig('agent_rtmr3')) {
      this.db.setConfig('agent_rtmr3', this.agentRtmr3);
      console.log(`[agent] RTMR3 locked: ${this.agentRtmr3}`);
    }

    const guardianRtmr3 = (process.env.GUARDIAN_APPROVED_RTMR3 ?? 'dev-measurement')
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

    // 13. ERC-8004 registration on first boot
    let evmMnemonic: string | null = null;
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
    if (!storedTokenId && this.evmWallet && baseRpcUrl) {
      try {
        const domain = process.env.CLOUDFLARE_DOMAIN ?? 'localhost:3001';
        const result = await this.erc8004Client.register({
          name: process.env.MOLTBOOK_HANDLE ?? 'idiostasis-agent',
          description: 'Idiostasis Protocol reference agent',
          services: [
            {
              name: 'teequote',
              endpoint: `https://${domain}:29343/cpu.html`,
            },
            {
              name: 'workload',
              endpoint: `https://${domain}/workload`,
            },
            {
              name: 'discovery',
              endpoint: `https://${domain}/discover`,
            },
          ],
          image: process.env.AGENT_IMAGE_URL,
          wallet: this.evmWallet,
        });
        this.erc8004TokenId = result.tokenId;
        this.db.setConfig('erc8004_token_id', String(result.tokenId));
        console.log(`[agent] ERC-8004 registered. Token ID: ${result.tokenId}`);
      } catch (err) {
        console.warn(`[agent] ERC-8004 registration failed (non-fatal): ${err}`);
      }
    } else if (storedTokenId) {
      this.erc8004TokenId = parseInt(storedTokenId, 10);
      console.log(`[agent] ERC-8004 token ID: ${storedTokenId}`);
    }

    // 14. Initialize x402 and SecretVM clients
    if (this.evmWallet && evmMnemonic) {
      const mnemonic = evmMnemonic;
      const x402Wallet = {
        address: this.evmWallet.address,
        signMessage: async (message: string) => {
          const account = mnemonicToAccount(mnemonic);
          return account.signMessage({ message });
        },
      };
      this.x402Client = new X402Client(
        x402Wallet,
        process.env.X402_FACILITATOR_URL,
      );

      const evmSigningWallet: EvmSigningWallet = {
        address: this.evmWallet.address,
        signMessage: (message: string) => x402Wallet.signMessage(message),
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
    };
    // x402 middleware for /discover (when EVM wallet is available)
    const httpOptions: import('./http/server.js').HttpServerOptions = {};
    if (this.evmWallet) {
      const payTo = this.evmWallet.address;
      const priceUsdc = this.config.discoveryPriceUsdc;
      const chain = process.env.BASE_NETWORK ?? 'base-sepolia';
      httpOptions.x402Middleware = (req, res, next) => {
        const payment = req.headers['x-payment'];
        if (payment) {
          // TODO: Phase 11+ — verify payment via facilitator
          next();
        } else {
          res.status(402).json({
            amount: priceUsdc * 1_000_000, // USDC 6 decimals
            currency: 'USDC',
            chain,
            payTo,
            memo: 'idiostasis agent discovery',
          });
        }
      };
    }
    this.httpServer = new HttpServer(deps, httpOptions);

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

    // Start autonomous guardian manager (primary only)
    if (this.role === 'primary' && this.secretvmClient && this.db) {
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
        this.db,
        this.config,
        guardianVmClient,
      );

      await this.guardianManager.evaluate().catch(err =>
        console.error('[guardian-manager] initial evaluate() error:', err)
      );
      setInterval(
        () => this.guardianManager!.evaluate().catch(err =>
          console.error('[guardian-manager] evaluate() error:', err)
        ),
        this.config.heartbeatIntervalMs,
      );
      console.log('[agent] Autonomous guardian manager started');
    } else if (this.role === 'primary') {
      console.warn('[agent] Guardian manager disabled — no SecretVM client');
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
