/**
 * In-memory registry client for development and testing.
 * In production, this will be replaced by a CosmWasm contract client
 * on Secret Network (or an ERC-8004 compatible registry).
 */
import type {
  RegistryClient,
  AgentRecord,
  RegistrationRequest,
  HeartbeatPayload,
  HeartbeatCheckResult,
} from './registry-types.js';

/** Heartbeat timeout in seconds (5 minutes). */
const HEARTBEAT_TIMEOUT_SECONDS = 300;

/**
 * Local in-memory registry — single-node implementation.
 * Guardians maintain consensus by syncing via API.
 * Will be replaced by on-chain contract in production.
 */
export class LocalRegistryClient implements RegistryClient {
  private currentAgent: AgentRecord | null = null;

  async getCurrentAgent(): Promise<AgentRecord | null> {
    return this.currentAgent;
  }

  async registerAgent(request: RegistrationRequest): Promise<{ success: boolean; error?: string }> {
    // If there's already an active agent, reject
    if (this.currentAgent?.isActive) {
      return { success: false, error: 'Another agent is already active' };
    }

    this.currentAgent = {
      teeInstanceId: request.teeInstanceId,
      codeHash: request.codeHash,
      isActive: true,
      lastHeartbeat: new Date().toISOString(),
      registeredAt: new Date().toISOString(),
      registeredBy: 'local',
    };

    return { success: true };
  }

  async heartbeat(payload: HeartbeatPayload): Promise<{ success: boolean; error?: string }> {
    if (!this.currentAgent) {
      return { success: false, error: 'No agent registered' };
    }

    if (this.currentAgent.teeInstanceId !== payload.teeInstanceId) {
      return { success: false, error: 'TEE instance ID mismatch' };
    }

    if (!this.currentAgent.isActive) {
      return { success: false, error: 'Agent is not active' };
    }

    this.currentAgent.lastHeartbeat = new Date(payload.timestamp).toISOString();
    return { success: true };
  }

  async checkHeartbeat(): Promise<HeartbeatCheckResult | null> {
    if (!this.currentAgent) return null;

    const lastBeat = new Date(this.currentAgent.lastHeartbeat).getTime();
    const secondsSince = Math.floor((Date.now() - lastBeat) / 1000);

    return {
      isActive: this.currentAgent.isActive,
      secondsSinceHeartbeat: secondsSince,
      shouldDeactivate: secondsSince > HEARTBEAT_TIMEOUT_SECONDS,
    };
  }

  async deactivateAgent(teeInstanceId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.currentAgent) {
      return { success: false, error: 'No agent registered' };
    }

    if (this.currentAgent.teeInstanceId !== teeInstanceId) {
      return { success: false, error: 'TEE instance ID mismatch' };
    }

    this.currentAgent.isActive = false;
    return { success: true };
  }

  async isRegistered(teeInstanceId: string): Promise<boolean> {
    return (
      this.currentAgent !== null &&
      this.currentAgent.teeInstanceId === teeInstanceId &&
      this.currentAgent.isActive
    );
  }
}

/**
 * Guardian-synced registry client — reads from guardian API.
 * Used by the fund manager agent to check/update registration
 * when the registry is managed by the guardian network.
 */
export class GuardianRegistryClient implements RegistryClient {
  private guardianEndpoint: string;

  constructor(guardianEndpoint: string) {
    this.guardianEndpoint = guardianEndpoint.replace(/\/$/, '');
  }

  async getCurrentAgent(): Promise<AgentRecord | null> {
    try {
      const res = await fetch(`${this.guardianEndpoint}/api/sentry/agent/current`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as AgentRecord;
    } catch {
      return null;
    }
  }

  async registerAgent(request: RegistrationRequest): Promise<{ success: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.guardianEndpoint}/api/sentry/agent/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(10_000),
      });
      return (await res.json()) as { success: boolean; error?: string };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async heartbeat(payload: HeartbeatPayload): Promise<{ success: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.guardianEndpoint}/api/sentry/agent/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      });
      return (await res.json()) as { success: boolean; error?: string };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async checkHeartbeat(): Promise<HeartbeatCheckResult | null> {
    try {
      const res = await fetch(`${this.guardianEndpoint}/api/sentry/agent/heartbeat-check`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as HeartbeatCheckResult;
    } catch {
      return null;
    }
  }

  async deactivateAgent(teeInstanceId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.guardianEndpoint}/api/sentry/agent/deactivate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teeInstanceId }),
        signal: AbortSignal.timeout(5_000),
      });
      return (await res.json()) as { success: boolean; error?: string };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async isRegistered(teeInstanceId: string): Promise<boolean> {
    const agent = await this.getCurrentAgent();
    return agent !== null && agent.teeInstanceId === teeInstanceId && agent.isActive;
  }
}
