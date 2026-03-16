import Database from 'better-sqlite3';
import { initializeSchema } from './schema.js';
import type { GuardianRecord, BackupAgentRecord } from '../interfaces.js';

export const ProtocolEventType = {
  ADMISSION: 'admission',
  HEARTBEAT_RESET: 'heartbeat_reset',
  SUCCESSION_INITIATED: 'succession_initiated',
  SUCCESSION_COMPLETE: 'succession_complete',
  RE_ATTESTATION: 're_attestation',
  GUARDIAN_REMOVED: 'guardian_removed',
  GUARDIAN_PROVISIONED: 'guardian_provisioned',
  GUARDIAN_DEPROVISIONED: 'guardian_deprovisioned',
  VAULT_KEY_ROTATED: 'vault_key_rotated',
} as const;

export type ProtocolEventType = (typeof ProtocolEventType)[keyof typeof ProtocolEventType];

export const CONFIG_KEYS = {
  AGENT_RTMR3: 'agent_rtmr3',
  ERC8004_TOKEN_ID: 'erc8004_token_id',
  EVM_MNEMONIC: 'evm_mnemonic',
  GUARDIAN_RTMR3: 'guardian_rtmr3',
  EXTERNAL_STABLE_SINCE: 'external_stable_since',
  SNAPSHOT_SEQUENCE_NUM: 'snapshot_sequence_num',
} as const;

export interface ProtocolEvent {
  id: number;
  eventType: string;
  detail: string | null;
  occurredAt: Date;
}

export class ProtocolDatabase {
  private db: Database.Database;
  private readonly dbPath: string;
  private readonly vaultKey: Uint8Array;

  constructor(dbPath: string, vaultKey: Uint8Array) {
    this.dbPath = dbPath;
    this.vaultKey = vaultKey;
    this.db = new Database(dbPath);
    initializeSchema(this.db);
  }

  getDbPath(): string {
    return this.dbPath;
  }

  getVaultKey(): Uint8Array {
    return this.vaultKey;
  }

  serialize(): Buffer {
    return this.db.serialize();
  }

  close(): void {
    this.db.close();
  }

  reinitialize(): void {
    this.db = new Database(this.dbPath);
    initializeSchema(this.db);
  }

  // --- Guardian operations ---

  upsertGuardian(record: GuardianRecord): void {
    this.db.prepare(`
      INSERT INTO guardians (
        id, network_address, tee_instance_id, rtmr3,
        admitted_at, last_attested_at, last_seen_at, status,
        provisioned_by, agent_vm_id
      ) VALUES (
        @id, @networkAddress, @teeInstanceId, @rtmr3,
        @admittedAt, @lastAttestedAt, @lastSeenAt, @status,
        @provisionedBy, @agentVmId
      )
      ON CONFLICT(id) DO UPDATE SET
        network_address = @networkAddress,
        tee_instance_id = @teeInstanceId,
        rtmr3 = @rtmr3,
        last_attested_at = @lastAttestedAt,
        last_seen_at = @lastSeenAt,
        status = @status,
        provisioned_by = @provisionedBy,
        agent_vm_id = @agentVmId
    `).run({
      id: record.id,
      networkAddress: record.networkAddress,
      teeInstanceId: record.teeInstanceId,
      rtmr3: record.rtmr3,
      admittedAt: record.admittedAt.getTime(),
      lastAttestedAt: record.lastAttestedAt.getTime(),
      lastSeenAt: record.lastSeenAt.getTime(),
      status: record.status,
      provisionedBy: record.provisionedBy,
      agentVmId: record.agentVmId,
    });
  }

  getGuardian(id: string): GuardianRecord | null {
    const row = this.db.prepare('SELECT * FROM guardians WHERE id = ?').get(id) as GuardianRow | undefined;
    return row ? rowToGuardian(row) : null;
  }

  listGuardians(status?: GuardianRecord['status']): GuardianRecord[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM guardians WHERE status = ?').all(status) as GuardianRow[]
      : this.db.prepare('SELECT * FROM guardians').all() as GuardianRow[];
    return rows.map(rowToGuardian);
  }

  removeGuardian(id: string): void {
    this.db.prepare('DELETE FROM guardians WHERE id = ?').run(id);
  }

  // --- Backup agent operations ---

  upsertBackupAgent(record: BackupAgentRecord): void {
    this.db.prepare(`
      INSERT INTO backup_agents (
        id, network_address, tee_instance_id, rtmr3,
        registered_at, heartbeat_streak, last_heartbeat_at, status
      ) VALUES (
        @id, @networkAddress, @teeInstanceId, @rtmr3,
        @registeredAt, @heartbeatStreak, @lastHeartbeatAt, @status
      )
      ON CONFLICT(id) DO UPDATE SET
        network_address = @networkAddress,
        tee_instance_id = @teeInstanceId,
        rtmr3 = @rtmr3,
        heartbeat_streak = @heartbeatStreak,
        last_heartbeat_at = @lastHeartbeatAt,
        status = @status
    `).run({
      id: record.id,
      networkAddress: record.networkAddress,
      teeInstanceId: record.teeInstanceId,
      rtmr3: record.rtmr3,
      registeredAt: record.registeredAt.getTime(),
      heartbeatStreak: record.heartbeatStreak,
      lastHeartbeatAt: record.lastHeartbeatAt.getTime(),
      status: record.status,
    });
  }

  getBackupAgent(id: string): BackupAgentRecord | null {
    const row = this.db.prepare('SELECT * FROM backup_agents WHERE id = ?').get(id) as BackupAgentRow | undefined;
    return row ? rowToBackupAgent(row) : null;
  }

  listBackupAgents(status?: BackupAgentRecord['status']): BackupAgentRecord[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM backup_agents WHERE status = ?').all(status) as BackupAgentRow[]
      : this.db.prepare('SELECT * FROM backup_agents').all() as BackupAgentRow[];
    return rows.map(rowToBackupAgent);
  }

  incrementStreak(id: string): void {
    this.db.prepare(`
      UPDATE backup_agents
      SET heartbeat_streak = heartbeat_streak + 1,
          last_heartbeat_at = @now
      WHERE id = @id
    `).run({ id, now: Date.now() });
  }

  resetStreak(id: string): void {
    this.db.prepare(`
      UPDATE backup_agents
      SET heartbeat_streak = 0,
          last_heartbeat_at = @now
      WHERE id = @id
    `).run({ id, now: Date.now() });
  }

  // --- Config operations ---

  setConfig(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO config (key, value) VALUES (@key, @value)
      ON CONFLICT(key) DO UPDATE SET value = @value
    `).run({ key, value });
  }

  getConfig(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  getConfigOrThrow(key: string): string {
    const value = this.getConfig(key);
    if (value === null) throw new Error(`Missing required config key: ${key}`);
    return value;
  }

  // --- Agent state operations ---

  setAgentState(blob: Uint8Array): void {
    this.db.prepare(`
      INSERT INTO agent_state (id, state_blob, updated_at, version)
      VALUES (1, @blob, @now, 1)
      ON CONFLICT(id) DO UPDATE SET
        state_blob = @blob,
        updated_at = @now,
        version = version + 1
    `).run({ blob: Buffer.from(blob), now: Date.now() });
  }

  getAgentState(): Uint8Array | null {
    const row = this.db.prepare('SELECT state_blob FROM agent_state WHERE id = 1').get() as { state_blob: Buffer } | undefined;
    return row ? new Uint8Array(row.state_blob) : null;
  }

  // --- Nonce cache ---

  checkAndStoreNonce(nonce: string): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO used_nonces (nonce, used_at) VALUES (@nonce, @now)
    `).run({ nonce, now: Date.now() });

    if (result.changes === 0) return false; // Already existed

    // Evict if over 10000
    const countRow = this.db.prepare('SELECT COUNT(*) as cnt FROM used_nonces').get() as { cnt: number };
    if (countRow.cnt > 10000) {
      this.db.prepare(`
        DELETE FROM used_nonces WHERE nonce IN (
          SELECT nonce FROM used_nonces ORDER BY used_at ASC LIMIT @excess
        )
      `).run({ excess: countRow.cnt - 9000 });
    }

    return true;
  }

  // --- Peer public keys ---

  setPeerPublicKey(teeInstanceId: string, ed25519PublicKey: Uint8Array, x25519PublicKey?: Uint8Array): void {
    this.db.prepare(`
      INSERT INTO peer_public_keys (tee_instance_id, ed25519_pubkey, x25519_pubkey, stored_at)
      VALUES (@teeInstanceId, @ed25519, @x25519, @now)
      ON CONFLICT(tee_instance_id) DO UPDATE SET
        ed25519_pubkey = @ed25519,
        x25519_pubkey = @x25519,
        stored_at = @now
    `).run({
      teeInstanceId,
      ed25519: Buffer.from(ed25519PublicKey),
      x25519: x25519PublicKey ? Buffer.from(x25519PublicKey) : null,
      now: Date.now(),
    });
  }

  getPeerPublicKey(teeInstanceId: string): { ed25519: Uint8Array; x25519: Uint8Array | null } | null {
    const row = this.db.prepare(
      'SELECT ed25519_pubkey, x25519_pubkey FROM peer_public_keys WHERE tee_instance_id = ?'
    ).get(teeInstanceId) as { ed25519_pubkey: Buffer; x25519_pubkey: Buffer | null } | undefined;
    if (!row) return null;
    return {
      ed25519: new Uint8Array(row.ed25519_pubkey),
      x25519: row.x25519_pubkey ? new Uint8Array(row.x25519_pubkey) : null,
    };
  }

  // --- Protocol events ---

  logEvent(eventType: string, detail?: string): void {
    this.db.prepare(`
      INSERT INTO protocol_events (event_type, detail, occurred_at)
      VALUES (@eventType, @detail, @now)
    `).run({ eventType, detail: detail ?? null, now: Date.now() });
  }

  getRecentEvents(limit: number): ProtocolEvent[] {
    const rows = this.db.prepare(
      'SELECT * FROM protocol_events ORDER BY occurred_at DESC LIMIT ?'
    ).all(limit) as ProtocolEventRow[];
    return rows.map(row => ({
      id: row.id,
      eventType: row.event_type,
      detail: row.detail,
      occurredAt: new Date(row.occurred_at),
    }));
  }
}

// --- Row types for SQLite ↔ TypeScript mapping ---

interface GuardianRow {
  id: string;
  network_address: string;
  tee_instance_id: string;
  rtmr3: string;
  admitted_at: number;
  last_attested_at: number;
  last_seen_at: number;
  status: 'active' | 'pending_re_attestation' | 'inactive';
  provisioned_by: 'agent' | 'external';
  agent_vm_id: string | null;
}

function rowToGuardian(row: GuardianRow): GuardianRecord {
  return {
    id: row.id,
    networkAddress: row.network_address,
    teeInstanceId: row.tee_instance_id,
    rtmr3: row.rtmr3,
    admittedAt: new Date(row.admitted_at),
    lastAttestedAt: new Date(row.last_attested_at),
    lastSeenAt: new Date(row.last_seen_at),
    status: row.status,
    provisionedBy: row.provisioned_by,
    agentVmId: row.agent_vm_id,
  };
}

interface BackupAgentRow {
  id: string;
  network_address: string;
  tee_instance_id: string;
  rtmr3: string;
  registered_at: number;
  heartbeat_streak: number;
  last_heartbeat_at: number;
  status: 'standby' | 'inactive';
}

function rowToBackupAgent(row: BackupAgentRow): BackupAgentRecord {
  return {
    id: row.id,
    networkAddress: row.network_address,
    teeInstanceId: row.tee_instance_id,
    rtmr3: row.rtmr3,
    registeredAt: new Date(row.registered_at),
    heartbeatStreak: row.heartbeat_streak,
    lastHeartbeatAt: new Date(row.last_heartbeat_at),
    status: row.status,
  };
}

interface ProtocolEventRow {
  id: number;
  event_type: string;
  detail: string | null;
  occurred_at: number;
}
