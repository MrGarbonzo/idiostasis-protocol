import { describe, it, expect } from 'vitest';
import { MultiChainWallet } from '../src/wallet/multi-chain-wallet.js';

// Known test mnemonic (DO NOT use in production)
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('MultiChainWallet', () => {
  it('creates a wallet with a valid 24-word mnemonic', () => {
    const wallet = MultiChainWallet.create();
    const words = wallet.mnemonic.split(' ');
    expect(words.length).toBe(24);
  });

  it('derives a deterministic EVM address from mnemonic', () => {
    const w1 = MultiChainWallet.fromMnemonic(TEST_MNEMONIC);
    const w2 = MultiChainWallet.fromMnemonic(TEST_MNEMONIC);
    expect(w1.addresses.evm).toBe(w2.addresses.evm);
  });

  it('derives a 0x-prefixed checksummed address', () => {
    const wallet = MultiChainWallet.fromMnemonic(TEST_MNEMONIC);
    expect(wallet.addresses.evm).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('derives the well-known address for the "abandon" mnemonic', () => {
    // Standard BIP-44 m/44'/60'/0'/0/0 for this mnemonic
    const wallet = MultiChainWallet.fromMnemonic(TEST_MNEMONIC);
    expect(wallet.addresses.evm.toLowerCase()).toBe(
      '0x9858effd232b4033e47d90003d41ec34ecaeda94',
    );
  });

  it('getEvmAccount() returns an account that matches the address', () => {
    const wallet = MultiChainWallet.fromMnemonic(TEST_MNEMONIC);
    const account = wallet.getEvmAccount();
    expect(account.address).toBe(wallet.addresses.evm);
  });

  it('rejects invalid mnemonics', () => {
    expect(() => MultiChainWallet.fromMnemonic('invalid mnemonic phrase')).toThrow(
      'Invalid BIP39 mnemonic',
    );
  });
});
