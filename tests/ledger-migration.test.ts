import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { DatabaseLedger } from '../src/database/ledger.js';

describe('DatabaseLedger — wallet column migration', () => {
  it('creates fresh DB with evm_address column', () => {
    const ledger = new DatabaseLedger(':memory:');
    const cols = ledger.db.prepare('PRAGMA table_info(wallet_state)').all() as Array<{ name: string }>;
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('evm_address');
    expect(colNames).not.toContain('solana_address');
    ledger.close();
  });

  it('migrates solana_address to evm_address on existing DB', () => {
    // Create a DB with the old schema
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE wallet_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mnemonic TEXT NOT NULL,
        solana_address TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS node_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        is_paused INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS node_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        parameters TEXT NOT NULL DEFAULT '{}',
        last_updated TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(`INSERT OR IGNORE INTO node_config (id, parameters) VALUES (1, '{}')`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS governance_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Insert old-format data
    db.prepare(
      `INSERT INTO wallet_state (id, mnemonic, solana_address) VALUES (1, 'test mnemonic', 'SoLAnaAddr123')`
    ).run();

    db.close();

    // Now re-open via DatabaseLedger which should trigger migration
    // Since :memory: is gone, we test via a temp file
    const tmp = require('os').tmpdir() + `/test-migration-${Date.now()}.db`;
    const rawDb = new Database(tmp);
    rawDb.exec(`
      CREATE TABLE wallet_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mnemonic TEXT NOT NULL,
        solana_address TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    rawDb.prepare(
      `INSERT INTO wallet_state (id, mnemonic, solana_address) VALUES (1, 'test words', 'OldSolAddr')`
    ).run();
    rawDb.close();

    // Open with ledger — should migrate
    const ledger = new DatabaseLedger(tmp);
    const cols = ledger.db.prepare('PRAGMA table_info(wallet_state)').all() as Array<{ name: string }>;
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('evm_address');
    expect(colNames).not.toContain('solana_address');

    // Data should be preserved
    const row = ledger.db.prepare('SELECT evm_address FROM wallet_state WHERE id = 1').get() as { evm_address: string };
    expect(row.evm_address).toBe('OldSolAddr');

    ledger.close();

    // Cleanup
    require('fs').unlinkSync(tmp);
  });

  it('saves and retrieves wallet state with evm_address', () => {
    const ledger = new DatabaseLedger(':memory:');
    ledger.saveWalletState({
      mnemonic: 'test mnemonic words here',
      evm_address: '0x1234567890abcdef1234567890abcdef12345678',
    });

    const state = ledger.getWalletState();
    expect(state).not.toBeNull();
    expect(state!.evm_address).toBe('0x1234567890abcdef1234567890abcdef12345678');
    ledger.close();
  });
});
