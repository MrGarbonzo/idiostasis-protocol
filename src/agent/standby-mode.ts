/**
 * Standby Mode — backup agents run but do NOT trade.
 *
 * A standby agent:
 *   - Has NO database (can't trade without it)
 *   - Has NO guardian connections (not registered)
 *   - Monitors the on-chain registry every 30s
 *   - When the primary's heartbeat times out → attempts takeover
 *
 * State machine:
 *   MONITORING → TAKEOVER_DETECTED → WAITING_DELAY → REQUESTING_REGISTRATION
 *     → REGISTERED (exits standby, becomes primary)
 *     → LOST_RACE (another backup won, return to MONITORING)
 *     → MONITORING (takeover failed for other reasons)
 */
import { getTEEInstanceId } from './tee.js';
import type { TEEIdentity } from './tee.js';

/** Interval between registry checks in milliseconds (30 seconds). */
const POLL_INTERVAL_MS = 30_000;

export type StandbyState =
  | 'monitoring'
  | 'takeover_detected'
  | 'waiting_delay'
  | 'requesting_registration'
  | 'registered'
  | 'lost_race'
  | 'error';

export interface StandbyStatus {
  state: StandbyState;
  teeIdentity: TEEIdentity | null;
  /** Seconds since standby started. */
  uptimeSeconds: number;
  /** Number of registry polls completed. */
  pollCount: number;
  /** Last poll result. */
  lastPollResult: PollResult | null;
  /** If takeover was attempted, the result. */
  takeoverResult: string | null;
}

export interface PollResult {
  timestamp: number;
  agentActive: boolean;
  agentTeeId: string | null;
  heartbeatFresh: boolean;
  /** Seconds since the active agent's last heartbeat. */
  secondsSinceHeartbeat: number | null;
}

export interface StandbyCallbacks {
  /** Called when primary failure is detected. Return true to attempt takeover. */
  onPrimaryFailure: (poll: PollResult) => Promise<boolean>;
  /** Called when this backup wins registration and becomes primary. */
  onBecamePrimary: (teeIdentity: TEEIdentity) => Promise<void>;
  /** Called when another backup won the race. */
  onLostRace: () => void;
  /** Called on each poll for logging. */
  onPoll?: (poll: PollResult) => void;
}

export interface StandbyManager {
  /** Start standby monitoring. */
  start(): Promise<void>;
  /** Stop standby monitoring. */
  stop(): void;
  /** Get current status. */
  status(): StandbyStatus;
}

/**
 * Create a standby mode manager.
 *
 * The manager polls the guardian registry at a fixed interval.
 * When it detects the primary agent has failed (heartbeat timeout),
 * it invokes the takeover flow.
 */
export function createStandbyManager(
  guardianEndpoint: string,
  callbacks: StandbyCallbacks,
): StandbyManager {
  const endpoint = guardianEndpoint.replace(/\/$/, '');
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let state: StandbyState = 'monitoring';
  let teeIdentity: TEEIdentity | null = null;
  let startTime = 0;
  let pollCount = 0;
  let lastPollResult: PollResult | null = null;
  let takeoverResult: string | null = null;

  /** Poll the registry for the current agent status. */
  async function poll(): Promise<PollResult> {
    try {
      const res = await fetch(`${endpoint}/api/sentry/agent/current`, {
        signal: AbortSignal.timeout(5_000),
      });

      if (res.status === 404) {
        // No agent registered at all
        return {
          timestamp: Date.now(),
          agentActive: false,
          agentTeeId: null,
          heartbeatFresh: false,
          secondsSinceHeartbeat: null,
        };
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const agent = (await res.json()) as {
        teeInstanceId: string;
        isActive: boolean;
        lastHeartbeat: string;
      };

      const secondsSince = Math.floor(
        (Date.now() - new Date(agent.lastHeartbeat).getTime()) / 1000,
      );

      return {
        timestamp: Date.now(),
        agentActive: agent.isActive,
        agentTeeId: agent.teeInstanceId,
        heartbeatFresh: secondsSince < 300, // 5 min timeout
        secondsSinceHeartbeat: secondsSince,
      };
    } catch {
      return {
        timestamp: Date.now(),
        agentActive: false,
        agentTeeId: null,
        heartbeatFresh: false,
        secondsSinceHeartbeat: null,
      };
    }
  }

  /** Main poll loop logic. */
  async function tick(): Promise<void> {
    // Don't poll if we're in the middle of a takeover
    if (state !== 'monitoring') return;

    pollCount++;
    const result = await poll();
    lastPollResult = result;
    callbacks.onPoll?.(result);

    // Check if primary has failed
    const primaryFailed =
      !result.agentActive ||
      !result.heartbeatFresh ||
      result.agentTeeId === null;

    if (primaryFailed) {
      state = 'takeover_detected';
      console.log('[Standby] Primary failure detected — initiating takeover');

      const shouldAttempt = await callbacks.onPrimaryFailure(result);
      if (!shouldAttempt) {
        state = 'monitoring';
        return;
      }

      state = 'requesting_registration';
      // The actual takeover logic is handled by backup-coordination.ts
      // via the onPrimaryFailure callback
    }
  }

  async function start(): Promise<void> {
    // Get our TEE identity
    teeIdentity = await getTEEInstanceId();
    console.log(`[Standby] TEE Instance ID: ${teeIdentity.instanceId}`);
    console.log(`[Standby] TDX mode: ${teeIdentity.isTDX}`);
    console.log(`[Standby] Entering standby mode — monitoring registry every ${POLL_INTERVAL_MS / 1000}s`);

    state = 'monitoring';
    startTime = Date.now();

    // Start polling
    intervalId = setInterval(tick, POLL_INTERVAL_MS);
    // First poll immediately
    await tick();
  }

  function stop(): void {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    console.log('[Standby] Stopped');
  }

  /** Transition to registered state (called by takeover coordinator). */
  function transitionToRegistered(): void {
    state = 'registered';
    takeoverResult = 'success';
    stop(); // Stop polling
  }

  /** Transition to lost race (called by takeover coordinator). */
  function transitionToLostRace(): void {
    state = 'monitoring'; // Return to monitoring
    takeoverResult = 'lost_race';
    callbacks.onLostRace();
  }

  function status(): StandbyStatus {
    return {
      state,
      teeIdentity,
      uptimeSeconds: startTime > 0 ? Math.floor((Date.now() - startTime) / 1000) : 0,
      pollCount,
      lastPollResult,
      takeoverResult,
    };
  }

  // Expose transition methods via the manager (used by backup-coordination)
  const manager: StandbyManager & {
    transitionToRegistered: () => void;
    transitionToLostRace: () => void;
    getTeeIdentity: () => TEEIdentity | null;
  } = {
    start,
    stop,
    status,
    transitionToRegistered,
    transitionToLostRace,
    getTeeIdentity: () => teeIdentity,
  };

  return manager;
}

/** Extended manager type with transition methods. */
export type StandbyManagerExtended = ReturnType<typeof createStandbyManager>;

// ── Agent-Registered Standby Mode ─────────────────────────────────

/** Heartbeat interval to the active agent (5 minutes). */
const AGENT_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

export type RegisteredStandbyState =
  | 'registering'
  | 'registered'
  | 'heartbeating'
  | 'agent_down'
  | 'polling_guardians'
  | 'takeover';

export interface RegisteredStandbyCallbacks {
  /** Called when the active agent is unreachable. Return a guardian endpoint to fall back to. */
  getGuardianEndpoint: () => string;
  /** Called when primary failure confirmed via guardian polling. Return true to attempt takeover. */
  onPrimaryFailure: (poll: PollResult) => Promise<boolean>;
  /** Called when this backup becomes primary. */
  onBecamePrimary: (teeIdentity: TEEIdentity) => Promise<void>;
  /** Called when another backup won. */
  onLostRace: () => void;
  /** Called on state transitions for logging. */
  onStateChange?: (from: RegisteredStandbyState, to: RegisteredStandbyState) => void;
}

export interface RegisteredStandbyManager {
  start(): Promise<void>;
  stop(): void;
  state(): RegisteredStandbyState;
}

/**
 * Create a standby manager that registers with the active agent.
 *
 * Instead of polling guardians from the start, this mode:
 *   1. Registers with the active agent's /api/backup/register
 *   2. Heartbeats to the agent every 30 minutes
 *   3. If the agent stops responding → falls back to guardian polling (existing standby)
 *   4. Guardian confirms primary is dead → triggers takeover
 */
export function createAgentRegisteredStandby(
  activeAgentEndpoint: string,
  ownId: string,
  ownEndpoint: string,
  callbacks: RegisteredStandbyCallbacks,
): RegisteredStandbyManager {
  const agentUrl = activeAgentEndpoint.replace(/\/$/, '');
  let currentState: RegisteredStandbyState = 'registering';
  let heartbeatIntervalId: ReturnType<typeof setInterval> | null = null;
  let guardianStandby: StandbyManagerExtended | null = null;

  function setState(next: RegisteredStandbyState): void {
    const prev = currentState;
    currentState = next;
    callbacks.onStateChange?.(prev, next);
  }

  /** Register with the active agent. */
  async function registerWithAgent(): Promise<boolean> {
    try {
      const res = await fetch(`${agentUrl}/api/backup/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: ownId, endpoint: ownEndpoint }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) return false;

      const data = (await res.json()) as { ok: boolean; position: number };
      if (data.ok) {
        console.log(`[RegisteredStandby] Registered at position ${data.position}`);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /** Send heartbeat to the active agent. */
  async function heartbeatAgent(): Promise<boolean> {
    try {
      const res = await fetch(`${agentUrl}/api/backup/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: ownId, endpoint: ownEndpoint }),
        signal: AbortSignal.timeout(10_000),
      });

      return res.ok;
    } catch {
      return false;
    }
  }

  /** Start the heartbeat loop. */
  function startHeartbeats(): void {
    setState('heartbeating');
    heartbeatIntervalId = setInterval(async () => {
      const ok = await heartbeatAgent();
      if (!ok) {
        console.log('[RegisteredStandby] Agent heartbeat failed — switching to guardian polling');
        stopHeartbeats();
        fallbackToGuardianPolling();
      }
    }, AGENT_HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeats(): void {
    if (heartbeatIntervalId) {
      clearInterval(heartbeatIntervalId);
      heartbeatIntervalId = null;
    }
  }

  /** Fall back to polling guardians (existing standby behavior). */
  function fallbackToGuardianPolling(): void {
    setState('agent_down');
    const guardianEndpoint = callbacks.getGuardianEndpoint();

    setState('polling_guardians');
    guardianStandby = createStandbyManager(guardianEndpoint, {
      onPrimaryFailure: async (poll) => {
        setState('takeover');
        return callbacks.onPrimaryFailure(poll);
      },
      onBecamePrimary: callbacks.onBecamePrimary,
      onLostRace: () => {
        callbacks.onLostRace();
        // After losing race, try re-registering with the new agent
        // (the new primary will be at a different endpoint — caller handles this)
      },
      onPoll: (poll) => {
        if (poll.agentActive && poll.heartbeatFresh) {
          // Agent came back (maybe another backup took over)
          console.log('[RegisteredStandby] Agent active again — stopping guardian polling');
          guardianStandby?.stop();
          guardianStandby = null;
          // Don't re-register — the new agent may be at a different endpoint
        }
      },
    });

    guardianStandby.start();
  }

  async function start(): Promise<void> {
    console.log(`[RegisteredStandby] Registering with active agent at ${agentUrl}`);
    setState('registering');

    const registered = await registerWithAgent();
    if (registered) {
      setState('registered');
      startHeartbeats();
    } else {
      console.log('[RegisteredStandby] Registration failed — agent may be down, falling back to guardian polling');
      fallbackToGuardianPolling();
    }
  }

  function stop(): void {
    stopHeartbeats();
    guardianStandby?.stop();
    guardianStandby = null;
    console.log('[RegisteredStandby] Stopped');
  }

  return {
    start,
    stop,
    state: () => currentState,
  };
}
