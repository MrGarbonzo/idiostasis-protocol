// packages/erc8004-client — barrel export

export {
  ERC8004Client,
  ERC8004_REGISTRY_ADDRESS_BASE_SEPOLIA,
  ERC8004_REGISTRY_ADDRESS_BASE_MAINNET,
  encodeMetadataToDataUri,
  decodeDataUri,
} from './client.js';
export type {
  AgentRegistration,
  ServiceRecord,
  RegistrationParams,
  EvmWallet,
} from './types.js';
