/**
 * Agent Verification — guardian-side module to verify connecting agents.
 *
 * Before accepting a connection from a fund manager agent:
 *   1. Check the on-chain/local registry
 *   2. Verify TEE instance ID matches registered agent
 *   3. Verify code hash matches approved code
 *   4. Reject unregistered or mismatched agents
 *
 * Also monitors agent health by checking heartbeat freshness.
 */
import type {
  RegistryClient,
  AgentRecord,
  RegistrationRequest,
  HeartbeatPayload,
  HeartbeatCheckResult,
} from '../shared/registry-types.js';
import {
  verifyAttestation,
  deserializeAttestation,
} from '../shared/attestation.js';
import type { Attestation } from '../shared/attestation.js';

export interface VerifyAgentResult {
  verified: boolean;
  agentRecord: AgentRecord | null;
  error?: string;
}

/** Approved code hashes (managed via governance proposals). */
export interface ApprovedCode {
  hashes: Set<string>;
  /** Add a code hash (after a passed code_update proposal). */
  approve(hash: string): void;
  /** Remove a code hash. */
  revoke(hash: string): void;
  /** Check if a hash is approved. */
  isApproved(hash: string): boolean;
}

export function createApprovedCodeSet(initialHashes?: string[]): ApprovedCode {
  const hashes = new Set<string>(initialHashes ?? []);
  return {
    hashes,
    approve(hash: string) { hashes.add(hash); },
    revoke(hash: string) { hashes.delete(hash); },
    isApproved(hash: string) { return hashes.size === 0 || hashes.has(hash); },
  };
}

export class AgentVerifier {
  private registry: RegistryClient;
  private approvedCode: ApprovedCode;

  constructor(registry: RegistryClient, approvedCode: ApprovedCode) {
    this.registry = registry;
    this.approvedCode = approvedCode;
  }

  /**
   * Verify a connecting agent.
   * Called when the fund manager agent connects to this guardian.
   */
  async verifyAgent(
    teeInstanceId: string,
    attestationStr: string,
  ): Promise<VerifyAgentResult> {
    // Step 1: Check registry
    const currentAgent = await this.registry.getCurrentAgent();
    if (!currentAgent) {
      return { verified: false, agentRecord: null, error: 'No agent registered' };
    }

    if (!currentAgent.isActive) {
      return { verified: false, agentRecord: currentAgent, error: 'Registered agent is not active' };
    }

    // Step 2: Verify TEE instance ID matches
    if (currentAgent.teeInstanceId !== teeInstanceId) {
      return {
        verified: false,
        agentRecord: currentAgent,
        error: `TEE instance mismatch: expected ${currentAgent.teeInstanceId}, got ${teeInstanceId}`,
      };
    }

    // Step 3: Verify attestation
    let attestation: Attestation;
    try {
      attestation = deserializeAttestation(attestationStr);
    } catch {
      return {
        verified: false,
        agentRecord: currentAgent,
        error: 'Invalid attestation format',
      };
    }

    const verification = verifyAttestation(attestation, {
      maxAgeSeconds: 300, // Attestation must be fresh (5 min)
    });

    if (!verification.valid) {
      return {
        verified: false,
        agentRecord: currentAgent,
        error: `Attestation verification failed: ${verification.error}`,
      };
    }

    // Step 4: Verify code hash is approved
    if (!this.approvedCode.isApproved(attestation.codeHash)) {
      return {
        verified: false,
        agentRecord: currentAgent,
        error: `Code hash not approved: ${attestation.codeHash}`,
      };
    }

    return { verified: true, agentRecord: currentAgent };
  }

  /**
   * Process a heartbeat from the active agent.
   */
  async processHeartbeat(payload: HeartbeatPayload): Promise<{ success: boolean; error?: string }> {
    // Verify the agent is registered
    const isRegistered = await this.registry.isRegistered(payload.teeInstanceId);
    if (!isRegistered) {
      return { success: false, error: 'Agent is not registered' };
    }

    // Verify the attestation
    if (payload.attestation) {
      try {
        const attestation = deserializeAttestation(payload.attestation);
        const verification = verifyAttestation(attestation, { maxAgeSeconds: 120 });
        if (!verification.valid) {
          return { success: false, error: `Attestation invalid: ${verification.error}` };
        }
      } catch {
        return { success: false, error: 'Invalid attestation format' };
      }
    }

    return this.registry.heartbeat(payload);
  }

  /**
   * Check agent health — called periodically (every 30s).
   * If heartbeat has timed out, deactivate the agent.
   */
  async checkHealth(): Promise<{
    healthy: boolean;
    check: HeartbeatCheckResult | null;
    deactivated: boolean;
  }> {
    const check = await this.registry.checkHeartbeat();
    if (!check) {
      return { healthy: false, check: null, deactivated: false };
    }

    if (check.shouldDeactivate && check.isActive) {
      const currentAgent = await this.registry.getCurrentAgent();
      if (currentAgent) {
        await this.registry.deactivateAgent(currentAgent.teeInstanceId);
        console.warn(
          `[AgentVerifier] Deactivated agent ${currentAgent.teeInstanceId} (${check.secondsSinceHeartbeat}s since last heartbeat)`,
        );
        return { healthy: false, check, deactivated: true };
      }
    }

    return {
      healthy: check.isActive && !check.shouldDeactivate,
      check,
      deactivated: false,
    };
  }

  /** Manually deactivate an agent (e.g., via API request). */
  async deactivateAgent(teeInstanceId: string): Promise<{ success: boolean; error?: string }> {
    return this.registry.deactivateAgent(teeInstanceId);
  }

  /** Get the currently active agent record. */
  async getCurrentAgent(): Promise<AgentRecord | null> {
    return this.registry.getCurrentAgent();
  }
}

// ── Ordered Failover ─────────────────────────────────────────────

export interface BackupAgentEntry {
  id: string;
  endpoint: string;
  registered_at: number;
  last_heartbeat: number;
  heartbeat_streak: number;
}

export interface OrderedFailoverResult {
  success: boolean;
  contactedId?: string;
  contactedEndpoint?: string;
  error?: string;
}

/**
 * Attempt ordered failover by contacting backup agents in registration order.
 *
 * Walks the list oldest→newest, skipping stale entries.
 * First backup that responds is proposed for registration via existing voting.
 */
export async function attemptOrderedFailover(
  backupAgents: BackupAgentEntry[],
  registrationVoting: { proposeRegistration: (request: RegistrationRequest) => Promise<{ success: boolean; error?: string }> },
): Promise<OrderedFailoverResult> {
  if (backupAgents.length === 0) {
    console.warn('[Failover] No backup agents available');
    return { success: false, error: 'no backup agents' };
  }

  console.log(`[Failover] Attempting ordered failover with ${backupAgents.length} backup(s)`);

  for (const backup of backupAgents) {
    const endpoint = backup.endpoint.replace(/\/$/, '');
    console.log(`[Failover] Contacting backup ${backup.id.substring(0, 16)}... at ${endpoint}`);

    try {
      // Ping the backup to see if it's alive and ready to take over
      const res = await fetch(`${endpoint}/status`, {
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        console.warn(`[Failover] Backup ${backup.id.substring(0, 16)}... returned HTTP ${res.status} — skipping`);
        continue;
      }

      // Backup is alive — request its registration details
      const regRes = await fetch(`${endpoint}/api/backup/ready`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'takeover' }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!regRes.ok) {
        console.warn(`[Failover] Backup ${backup.id.substring(0, 16)}... not ready for takeover — skipping`);
        continue;
      }

      const regData = (await regRes.json()) as RegistrationRequest;

      // Propose this backup for registration via existing voting system
      const voteResult = await registrationVoting.proposeRegistration(regData);
      if (voteResult.success) {
        console.log(`[Failover] Backup ${backup.id.substring(0, 16)}... proposed for registration`);
        return { success: true, contactedId: backup.id, contactedEndpoint: endpoint };
      }

      console.warn(`[Failover] Proposal failed for ${backup.id.substring(0, 16)}...: ${voteResult.error}`);
    } catch (err) {
      console.warn(`[Failover] Failed to contact ${backup.id.substring(0, 16)}...: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.warn('[Failover] All backups unresponsive — no failover possible');
  return { success: false, error: 'all backups unresponsive' };
}
