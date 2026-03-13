import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { privateKeyToAccount } from 'viem/accounts';
import type { LocalAccount } from 'viem/accounts';
import type Database from 'better-sqlite3';
import type { WalletAddresses, WalletInfo } from './types.js';

// Derivation path: BIP-44 Ethereum
const EVM_PATH = "m/44'/60'/0'/0/0";

export class MultiChainWallet {
  readonly mnemonic: string;
  readonly addresses: WalletAddresses;

  private readonly seed: Uint8Array;

  private constructor(mnemonic: string) {
    if (!validateMnemonic(mnemonic, wordlist)) {
      throw new Error('Invalid BIP39 mnemonic');
    }
    this.mnemonic = mnemonic;
    this.seed = mnemonicToSeedSync(mnemonic);
    this.addresses = this.deriveAddresses();
  }

  // ── Static Factories ──────────────────────────────────────

  /** Generate a new 24-word mnemonic and derive all wallets. */
  static create(): MultiChainWallet {
    const mnemonic = generateMnemonic(wordlist, 256); // 256 bits = 24 words
    return new MultiChainWallet(mnemonic);
  }

  /** Restore from an existing mnemonic phrase. */
  static fromMnemonic(mnemonic: string): MultiChainWallet {
    return new MultiChainWallet(mnemonic);
  }

  /** Load from DB if exists, otherwise create + persist. */
  static initializeFromDB(db: Database.Database): MultiChainWallet {
    const row = db.prepare('SELECT * FROM wallet_state WHERE id = 1').get() as
      | { mnemonic: string }
      | undefined;

    if (row) {
      return new MultiChainWallet(row.mnemonic);
    }

    const wallet = MultiChainWallet.create();
    wallet.persistToDB(db);
    return wallet;
  }

  /** Restore from DB — throws if no wallet_state row exists. */
  static restoreFromDB(db: Database.Database): MultiChainWallet {
    const row = db.prepare('SELECT * FROM wallet_state WHERE id = 1').get() as
      | { mnemonic: string }
      | undefined;

    if (!row) {
      throw new Error('No wallet state found in database');
    }
    return new MultiChainWallet(row.mnemonic);
  }

  // ── Address Derivation (sync, CPU only) ───────────────────

  private deriveAddresses(): WalletAddresses {
    return {
      evm: this.deriveEvmAddress(),
    };
  }

  private deriveEvmAddress(): string {
    const hdkey = HDKey.fromMasterSeed(this.seed);
    const derived = hdkey.derive(EVM_PATH);
    const account = privateKeyToAccount(`0x${Buffer.from(derived.privateKey!).toString('hex')}`);
    return account.address;
  }

  // ── Signer Accessors ──────────────────────────────────────

  getEvmAccount(): LocalAccount {
    const hdkey = HDKey.fromMasterSeed(this.seed);
    const derived = hdkey.derive(EVM_PATH);
    return privateKeyToAccount(`0x${Buffer.from(derived.privateKey!).toString('hex')}`);
  }

  // ── DB Persistence ────────────────────────────────────────

  persistToDB(db: Database.Database): void {
    db.prepare(
      `INSERT OR REPLACE INTO wallet_state (id, mnemonic, evm_address, updated_at)
       VALUES (1, ?, ?, datetime('now'))`
    ).run(
      this.mnemonic,
      this.addresses.evm,
    );
  }

  // ── Utility ───────────────────────────────────────────────

  getInfo(): WalletInfo {
    return {
      mnemonic: this.mnemonic,
      addresses: { ...this.addresses },
    };
  }
}
