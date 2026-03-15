/**
 * Moltbook application state schema.
 * This is application-specific — the protocol knows nothing about it.
 */

export interface MoltbookState {
  agentHandle: string;
  displayName: string;
  createdAt: string;
  recoveryCount: number;
  lastRecoveryAt: string | null;
  credentials: {
    sessionToken: string | null;
    sessionExpiresAt: string | null;
  };
}

export function createInitialState(handle: string, displayName: string): MoltbookState {
  return {
    agentHandle: handle,
    displayName,
    createdAt: new Date().toISOString(),
    recoveryCount: 0,
    lastRecoveryAt: null,
    credentials: {
      sessionToken: null,
      sessionExpiresAt: null,
    },
  };
}
