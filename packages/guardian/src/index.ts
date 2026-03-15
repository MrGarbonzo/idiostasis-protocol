// packages/guardian — barrel export

export { LivenessMonitor } from './liveness/monitor.js';
export type { SuccessionInitiator } from './liveness/monitor.js';

export { SuccessionHandler } from './succession/handler.js';

export { PeerRegistry } from './peers/registry.js';
export type { PeerRecord } from './peers/registry.js';

export { Erc8004Discovery } from './discovery/erc8004.js';

export { AutonomousGuardianManager } from './guardian-manager.js';
export type { SecretVmClient, CreateVmParams } from './guardian-manager.js';

export { createHandlers } from './http-server.js';
export type { AdmissionPayload, OnAdmissionReceived, GuardianHttpHandlers } from './http-server.js';

export { GuardianHttpServer } from './guardian-http-server.js';
export type { VaultKeyUpdatePayload, OnVaultKeyUpdate } from './guardian-http-server.js';

export { startGuardian } from './main.js';
