export interface AgentRegistration {
  tokenId: number;
  owner: string;
  name: string;
  description: string;
  services: ServiceRecord[];
  active: boolean;
  registeredAt: number;
  updatedAt: number;
}

export interface ServiceRecord {
  name: string;
  endpoint: string;
}

export interface RegistrationParams {
  name: string;
  description: string;
  services: ServiceRecord[];
  wallet: EvmWallet;
  image?: string;
}

export interface EvmWallet {
  address: string;
  signTransaction(tx: unknown): Promise<string>;
  /** Opaque viem Account object for contract interactions */
  account: unknown;
}
