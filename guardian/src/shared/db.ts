/**
 * SQLite database wrapper for Guardian Network.
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createDatabase(dbPath: string = ':memory:'): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const schemaPath = join(__dirname, '../../database/schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);

  // Migrate existing DBs: add fund_id column to proposals if missing
  const cols = db.pragma('table_info(proposals)') as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'fund_id')) {
    db.exec('ALTER TABLE proposals ADD COLUMN fund_id TEXT');
  }

  return db;
}
