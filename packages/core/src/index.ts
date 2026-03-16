// packages/core — barrel export

export type {
  AgentStateAdapter,
  HealthCheckAdapter,
  HealthCheckResult,
  AttestationProvider,
  AttestationResult,
  SelfReport,
  ProtocolConfig,
  GuardianRecord,
  BackupAgentRecord,
  BootHook,
} from './interfaces.js';

export {
  HEARTBEAT_INTERVAL_MS,
  LIVENESS_FAILURE_THRESHOLD,
  RE_ATTESTATION_INTERVAL_HOURS,
  DB_SNAPSHOT_INTERVAL_MS,
  PEER_STALENESS_MS,
  MIN_GUARDIAN_COUNT,
  BACKUP_JITTER_MAX_MS,
  RE_ATTEST_FAILURE_LIMIT,
  DEFAULT_PCCS_ENDPOINTS,
  loadConfig,
} from './config.js';

// Vault key lifecycle
export { VaultKeyManager, generateAgentMnemonic } from './vault/key-manager.js';
export { deriveSealingKey, sealData, unsealData, resolveTeeInstanceId, resolveSecretvmDomain, resolveSecretvmDomainFromTls } from './vault/sealing.js';
export type { SealedData } from './vault/sealing.js';
export { KeyExchangeSession } from './vault/exchange.js';
export type { WrappedKey, PublicKeys } from './vault/exchange.js';

// Attestation
export { SecretLabsAttestationProvider, parseSelfReport } from './attestation/provider.js';
export { extractQuoteFromHtml } from './attestation/cpu-html.js';
export { verifyWithPccs, readLocalRtmr3 } from './attestation/pccs-client.js';
export type { PccsFetcher } from './attestation/pccs-client.js';
export { AdmissionService } from './attestation/admission.js';
export type { AdmissionRequest, AdmissionResult } from './attestation/admission.js';

// Database
export { ProtocolDatabase, ProtocolEventType, CONFIG_KEYS } from './database/db.js';
export type { ProtocolEvent } from './database/db.js';
export { SnapshotManager } from './database/snapshot.js';
export type { DbSnapshot } from './database/snapshot.js';
export { initializeSchema } from './database/schema.js';

// Heartbeat
export { HeartbeatManager } from './heartbeat/manager.js';
export type { PingEnvelope, PingTransport, PingSigner } from './heartbeat/manager.js';

// Utilities
export { stableStringify } from './utils.js';

// Succession
export { selectSuccessor } from './succession/selector.js';
export {
  SuccessionManager,
  SuccessionExhaustedError,
  handleBackupReadyRequest,
  handleSuccessionReceive,
  rotateVaultKey,
} from './succession/manager.js';
export type {
  SuccessionTransport,
  CandidateReadyResponse,
  Erc8004Checker,
  BackupReadyRequest,
  BackupReadyResponse,
  VaultKeyTransport,
} from './succession/manager.js';
