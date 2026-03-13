export type ChainId = 'evm';

export interface WalletAddresses {
  evm: string;  // 0x-prefixed checksummed address
}

export interface WalletInfo {
  mnemonic: string;
  addresses: WalletAddresses;
}

export interface DerivedKeys {
  evm: Uint8Array;   // 32-byte secp256k1 private key
}
