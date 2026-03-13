import { DatabaseLedger } from '../database/ledger.js';
import { MultiChainWallet } from '../wallet/multi-chain-wallet.js';

export interface DiscoveredGuardian {
  address: string;
  endpoint: string;
  isSentry: boolean;
  discoveredAt: number;
  lastSeen: number;
  verified: boolean;
}

export interface ServiceContext {
  db: DatabaseLedger;
  wallet: MultiChainWallet;
  discoveredGuardians: Map<string, DiscoveredGuardian>;
}

export interface ContextConfig {
  dbPath: string;
  evmRpcUrl: string;
}

let _ctx: ServiceContext | null = null;

/**
 * Initialize the shared service context. Called once on startup.
 * First boot: generates mnemonic + persists to wallet_state table.
 * Subsequent boots: restores wallet from DB.
 */
export function initContext(config: ContextConfig): ServiceContext {
  if (_ctx) return _ctx;

  const db = new DatabaseLedger(config.dbPath);
  const wallet = MultiChainWallet.initializeFromDB(db.db);

  _ctx = { db, wallet, discoveredGuardians: new Map() };
  return _ctx;
}

/** Get the initialized context. Throws if initContext hasn't been called. */
export function getContext(): ServiceContext {
  if (!_ctx) {
    throw new Error('ServiceContext not initialized — call initContext() first');
  }
  return _ctx;
}
