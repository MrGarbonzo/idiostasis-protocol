/**
 * Telegram Group Protocol — structured message formats for agent/guardian communication.
 * Both projects parse and format these messages identically.
 */

// ── Data types ────────────────────────────────────────────────────

export interface AgentAnnounceData {
  endpoint: string;
  teeId: string;
  codeHash: string;
}

export interface GuardianAnnounceData {
  address: string;
  endpoint: string;
  isSentry: boolean;
}

export interface DiscoverResponseData {
  address: string;
  endpoint: string;
  isSentry: boolean;
}

export interface ProposalNewData {
  id: string;
  type: string;
  thresholdPct: number;
  deadline: string;
}

export interface ProposalResultData {
  id: string;
  status: 'approved' | 'rejected';
  approvalPct: number;
}

export interface HeartbeatStatusData {
  active: boolean;
  uptime: number;
}

// ── Trust event data types ───────────────────────────────────────

export interface AttestationRequestData {
  peerId: string;
  pubkey: string; // first 8 chars of pubkey
}

export interface AttestationVerifiedData {
  peerId: string;
  pubkey: string;
  isSentry: boolean;
}

export interface AttestationRejectedData {
  peerId: string;
  reason: string;
}

export interface VaultKeySentData {
  toPeerId: string;
}

export interface VaultKeyReceivedData {
  fromPeerId: string;
}

export interface DbSyncSentData {
  seq: number;
  peers: number;
  sizeKB: number;
}

export interface DbSyncReceivedData {
  fromPeerId: string;
  seq: number;
}

export interface DbSyncRejectedData {
  fromPeerId: string;
  reason: string;
}

export interface RecoveryRequestData {
  fromPeerId: string;
}

export interface RecoveryServedData {
  toPeerId: string;
  seq: number;
}

export interface TrustPeerAddedData {
  peerId: string;
  isSentry: boolean;
}

export interface TrustPeerRemovedData {
  peerId: string;
}

// ── Protocol message union ────────────────────────────────────────

export type ProtocolMessage =
  | { kind: 'agent_announce'; data: AgentAnnounceData }
  | { kind: 'guardian_announce'; data: GuardianAnnounceData }
  | { kind: 'discover_request' }
  | { kind: 'discover_response'; data: DiscoverResponseData }
  | { kind: 'proposal_new'; data: ProposalNewData }
  | { kind: 'proposal_result'; data: ProposalResultData }
  | { kind: 'heartbeat_status'; data: HeartbeatStatusData }
  | { kind: 'attestation_request'; data: AttestationRequestData }
  | { kind: 'attestation_verified'; data: AttestationVerifiedData }
  | { kind: 'attestation_rejected'; data: AttestationRejectedData }
  | { kind: 'vault_key_sent'; data: VaultKeySentData }
  | { kind: 'vault_key_received'; data: VaultKeyReceivedData }
  | { kind: 'db_sync_sent'; data: DbSyncSentData }
  | { kind: 'db_sync_received'; data: DbSyncReceivedData }
  | { kind: 'db_sync_rejected'; data: DbSyncRejectedData }
  | { kind: 'recovery_request'; data: RecoveryRequestData }
  | { kind: 'recovery_served'; data: RecoveryServedData }
  | { kind: 'trust_peer_added'; data: TrustPeerAddedData }
  | { kind: 'trust_peer_removed'; data: TrustPeerRemovedData };

// ── Format functions ──────────────────────────────────────────────

export function formatAgentAnnounce(data: AgentAnnounceData): string {
  return `[ANNOUNCE:AGENT] endpoint=${data.endpoint} teeId=${data.teeId} codeHash=${data.codeHash}`;
}

export function formatGuardianAnnounce(data: GuardianAnnounceData): string {
  return `[ANNOUNCE:GUARDIAN] address=${data.address} endpoint=${data.endpoint} sentry=${data.isSentry}`;
}

export function formatDiscoverRequest(): string {
  return '[DISCOVER:REQUEST]';
}

export function formatDiscoverResponse(data: DiscoverResponseData): string {
  return `[DISCOVER:RESPONSE] address=${data.address} endpoint=${data.endpoint} sentry=${data.isSentry}`;
}

export function formatProposalNew(data: ProposalNewData): string {
  return `[PROPOSAL:NEW] id=${data.id} type=${data.type} threshold=${data.thresholdPct}% deadline=${data.deadline}`;
}

export function formatProposalResult(data: ProposalResultData): string {
  return `[PROPOSAL:RESULT] id=${data.id} status=${data.status} approval=${data.approvalPct}%`;
}

export function formatHeartbeatStatus(data: HeartbeatStatusData): string {
  return `[HEARTBEAT:STATUS] active=${data.active} uptime=${data.uptime}`;
}

// ── Trust event format functions ─────────────────────────────────

export function formatAttestationRequest(data: AttestationRequestData): string {
  return `[ATTESTATION:REQUEST] peerId=${data.peerId} pubkey=${data.pubkey}`;
}

export function formatAttestationVerified(data: AttestationVerifiedData): string {
  return `[ATTESTATION:VERIFIED] peerId=${data.peerId} pubkey=${data.pubkey} sentry=${data.isSentry}`;
}

export function formatAttestationRejected(data: AttestationRejectedData): string {
  return `[ATTESTATION:REJECTED] peerId=${data.peerId} reason=${data.reason}`;
}

export function formatVaultKeySent(data: VaultKeySentData): string {
  return `[VAULT:KEY_SENT] toPeerId=${data.toPeerId}`;
}

export function formatVaultKeyReceived(data: VaultKeyReceivedData): string {
  return `[VAULT:KEY_RECEIVED] fromPeerId=${data.fromPeerId}`;
}

export function formatDbSyncSent(data: DbSyncSentData): string {
  return `[DB:SYNC_SENT] seq=${data.seq} peers=${data.peers} sizeKB=${data.sizeKB}`;
}

export function formatDbSyncReceived(data: DbSyncReceivedData): string {
  return `[DB:SYNC_RECEIVED] fromPeerId=${data.fromPeerId} seq=${data.seq}`;
}

export function formatDbSyncRejected(data: DbSyncRejectedData): string {
  return `[DB:SYNC_REJECTED] fromPeerId=${data.fromPeerId} reason=${data.reason}`;
}

export function formatRecoveryRequest(data: RecoveryRequestData): string {
  return `[RECOVERY:REQUEST] fromPeerId=${data.fromPeerId}`;
}

export function formatRecoveryServed(data: RecoveryServedData): string {
  return `[RECOVERY:SERVED] toPeerId=${data.toPeerId} seq=${data.seq}`;
}

export function formatTrustPeerAdded(data: TrustPeerAddedData): string {
  return `[TRUST:PEER_ADDED] peerId=${data.peerId} sentry=${data.isSentry}`;
}

export function formatTrustPeerRemoved(data: TrustPeerRemovedData): string {
  return `[TRUST:PEER_REMOVED] peerId=${data.peerId}`;
}

// ── Parse helpers ─────────────────────────────────────────────────

function extractField(text: string, key: string): string | undefined {
  // Match key=value where value goes until the next space-followed-by-key= or end of string
  const regex = new RegExp(`(?:^|\\s)${key}=(\\S+)`);
  const m = text.match(regex);
  return m?.[1];
}

function extractPercentField(text: string, key: string): number | undefined {
  const regex = new RegExp(`(?:^|\\s)${key}=(\\d+(?:\\.\\d+)?)%`);
  const m = text.match(regex);
  return m ? Number(m[1]) : undefined;
}

// ── Parse function ────────────────────────────────────────────────

export function parseProtocolMessage(text: string): ProtocolMessage | null {
  const trimmed = text.trim();

  if (trimmed.startsWith('[ANNOUNCE:AGENT]')) {
    const rest = trimmed.slice('[ANNOUNCE:AGENT]'.length);
    const endpoint = extractField(rest, 'endpoint');
    const teeId = extractField(rest, 'teeId');
    const codeHash = extractField(rest, 'codeHash');
    if (!endpoint || !teeId || !codeHash) return null;
    return { kind: 'agent_announce', data: { endpoint, teeId, codeHash } };
  }

  if (trimmed.startsWith('[ANNOUNCE:GUARDIAN]')) {
    const rest = trimmed.slice('[ANNOUNCE:GUARDIAN]'.length);
    const address = extractField(rest, 'address');
    const endpoint = extractField(rest, 'endpoint');
    const sentry = extractField(rest, 'sentry');
    if (!address || !endpoint || sentry === undefined) return null;
    return {
      kind: 'guardian_announce',
      data: { address, endpoint, isSentry: sentry === 'true' },
    };
  }

  if (trimmed === '[DISCOVER:REQUEST]') {
    return { kind: 'discover_request' };
  }

  if (trimmed.startsWith('[DISCOVER:RESPONSE]')) {
    const rest = trimmed.slice('[DISCOVER:RESPONSE]'.length);
    const address = extractField(rest, 'address');
    const endpoint = extractField(rest, 'endpoint');
    const sentry = extractField(rest, 'sentry');
    if (!address || !endpoint || sentry === undefined) return null;
    return {
      kind: 'discover_response',
      data: { address, endpoint, isSentry: sentry === 'true' },
    };
  }

  if (trimmed.startsWith('[PROPOSAL:NEW]')) {
    const rest = trimmed.slice('[PROPOSAL:NEW]'.length);
    const id = extractField(rest, 'id');
    const type = extractField(rest, 'type');
    const thresholdPct = extractPercentField(rest, 'threshold');
    const deadline = extractField(rest, 'deadline');
    if (!id || !type || thresholdPct === undefined || !deadline) return null;
    return { kind: 'proposal_new', data: { id, type, thresholdPct, deadline } };
  }

  if (trimmed.startsWith('[PROPOSAL:RESULT]')) {
    const rest = trimmed.slice('[PROPOSAL:RESULT]'.length);
    const id = extractField(rest, 'id');
    const status = extractField(rest, 'status') as 'approved' | 'rejected' | undefined;
    const approvalPct = extractPercentField(rest, 'approval');
    if (!id || !status || approvalPct === undefined) return null;
    if (status !== 'approved' && status !== 'rejected') return null;
    return { kind: 'proposal_result', data: { id, status, approvalPct } };
  }

  if (trimmed.startsWith('[HEARTBEAT:STATUS]')) {
    const rest = trimmed.slice('[HEARTBEAT:STATUS]'.length);
    const active = extractField(rest, 'active');
    const uptime = extractField(rest, 'uptime');
    if (active === undefined || !uptime) return null;
    return {
      kind: 'heartbeat_status',
      data: { active: active === 'true', uptime: Number(uptime) },
    };
  }

  // ── Trust event parse cases ──────────────────────────────────

  if (trimmed.startsWith('[ATTESTATION:REQUEST]')) {
    const rest = trimmed.slice('[ATTESTATION:REQUEST]'.length);
    const peerId = extractField(rest, 'peerId');
    const pubkey = extractField(rest, 'pubkey');
    if (!peerId || !pubkey) return null;
    return { kind: 'attestation_request', data: { peerId, pubkey } };
  }

  if (trimmed.startsWith('[ATTESTATION:VERIFIED]')) {
    const rest = trimmed.slice('[ATTESTATION:VERIFIED]'.length);
    const peerId = extractField(rest, 'peerId');
    const pubkey = extractField(rest, 'pubkey');
    const sentry = extractField(rest, 'sentry');
    if (!peerId || !pubkey || sentry === undefined) return null;
    return {
      kind: 'attestation_verified',
      data: { peerId, pubkey, isSentry: sentry === 'true' },
    };
  }

  if (trimmed.startsWith('[ATTESTATION:REJECTED]')) {
    const rest = trimmed.slice('[ATTESTATION:REJECTED]'.length);
    const peerId = extractField(rest, 'peerId');
    const reason = extractField(rest, 'reason');
    if (!peerId || !reason) return null;
    return { kind: 'attestation_rejected', data: { peerId, reason } };
  }

  if (trimmed.startsWith('[VAULT:KEY_SENT]')) {
    const rest = trimmed.slice('[VAULT:KEY_SENT]'.length);
    const toPeerId = extractField(rest, 'toPeerId');
    if (!toPeerId) return null;
    return { kind: 'vault_key_sent', data: { toPeerId } };
  }

  if (trimmed.startsWith('[VAULT:KEY_RECEIVED]')) {
    const rest = trimmed.slice('[VAULT:KEY_RECEIVED]'.length);
    const fromPeerId = extractField(rest, 'fromPeerId');
    if (!fromPeerId) return null;
    return { kind: 'vault_key_received', data: { fromPeerId } };
  }

  if (trimmed.startsWith('[DB:SYNC_SENT]')) {
    const rest = trimmed.slice('[DB:SYNC_SENT]'.length);
    const seq = extractField(rest, 'seq');
    const peers = extractField(rest, 'peers');
    const sizeKB = extractField(rest, 'sizeKB');
    if (!seq || !peers || !sizeKB) return null;
    return {
      kind: 'db_sync_sent',
      data: { seq: Number(seq), peers: Number(peers), sizeKB: Number(sizeKB) },
    };
  }

  if (trimmed.startsWith('[DB:SYNC_RECEIVED]')) {
    const rest = trimmed.slice('[DB:SYNC_RECEIVED]'.length);
    const fromPeerId = extractField(rest, 'fromPeerId');
    const seq = extractField(rest, 'seq');
    if (!fromPeerId || !seq) return null;
    return {
      kind: 'db_sync_received',
      data: { fromPeerId, seq: Number(seq) },
    };
  }

  if (trimmed.startsWith('[DB:SYNC_REJECTED]')) {
    const rest = trimmed.slice('[DB:SYNC_REJECTED]'.length);
    const fromPeerId = extractField(rest, 'fromPeerId');
    const reason = extractField(rest, 'reason');
    if (!fromPeerId || !reason) return null;
    return { kind: 'db_sync_rejected', data: { fromPeerId, reason } };
  }

  if (trimmed.startsWith('[RECOVERY:REQUEST]')) {
    const rest = trimmed.slice('[RECOVERY:REQUEST]'.length);
    const fromPeerId = extractField(rest, 'fromPeerId');
    if (!fromPeerId) return null;
    return { kind: 'recovery_request', data: { fromPeerId } };
  }

  if (trimmed.startsWith('[RECOVERY:SERVED]')) {
    const rest = trimmed.slice('[RECOVERY:SERVED]'.length);
    const toPeerId = extractField(rest, 'toPeerId');
    const seq = extractField(rest, 'seq');
    if (!toPeerId || !seq) return null;
    return { kind: 'recovery_served', data: { toPeerId, seq: Number(seq) } };
  }

  if (trimmed.startsWith('[TRUST:PEER_ADDED]')) {
    const rest = trimmed.slice('[TRUST:PEER_ADDED]'.length);
    const peerId = extractField(rest, 'peerId');
    const sentry = extractField(rest, 'sentry');
    if (!peerId || sentry === undefined) return null;
    return {
      kind: 'trust_peer_added',
      data: { peerId, isSentry: sentry === 'true' },
    };
  }

  if (trimmed.startsWith('[TRUST:PEER_REMOVED]')) {
    const rest = trimmed.slice('[TRUST:PEER_REMOVED]'.length);
    const peerId = extractField(rest, 'peerId');
    if (!peerId) return null;
    return { kind: 'trust_peer_removed', data: { peerId } };
  }

  return null;
}
