// Database
export { DatabaseLedger } from './database/ledger.js';

// Types
export type { WalletState } from './types/wallet.js';

// Errors
export { InvariantViolationError, NodePausedError } from './types/errors.js';

// Wallet
export { MultiChainWallet } from './wallet/multi-chain-wallet.js';
export type { ChainId, WalletAddresses, WalletInfo } from './wallet/types.js';

// Registry
export { ERC8004RegistryClient } from './registry/erc8004-registry-client.js';

// TEE
export { createTEESigner, loadAttestationQuote, aesEncrypt } from './agent/tee-signing.js';
export { getTEEInstanceId } from './agent/tee.js';
export { generateAttestation, serializeAttestation } from './agent/attestation-utils.js';

// Guardian
export { verifyGuardianAttestation, verifyQuoteViaPCCS } from './agent/guardian-verifier.js';
export { runRegistrationFlow } from './agent/registration.js';
export { createHeartbeatManager } from './agent/heartbeat.js';

// Backup / Failover
export { runBackupAgent, registerSelfOnChain } from './agent/backup-coordination.js';

// Vault
export { VaultClient } from './agent/vault-client.js';
export { VaultKeyManager } from './vault/key-manager.js';

// LLM
export { ResilientLLM } from './agent/resilient-llm.js';

// Context
export { initContext, getContext } from './agent/context.js';
export type { ServiceContext, DiscoveredGuardian, ContextConfig } from './agent/context.js';

// Config
export { handleConfigRequest } from './agent/config-api.js';

// Cron
export { startCronJobs } from './agent/cron.js';
