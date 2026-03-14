export { selectSuccessor } from './selector.js';
export {
  SuccessionManager,
  SuccessionExhaustedError,
  handleBackupReadyRequest,
  handleSuccessionReceive,
  rotateVaultKey,
} from './manager.js';
export type {
  SuccessionTransport,
  CandidateReadyResponse,
  Erc8004Checker,
  BackupReadyRequest,
  BackupReadyResponse,
} from './manager.js';
