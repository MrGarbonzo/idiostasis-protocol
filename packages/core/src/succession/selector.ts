import type { BackupAgentRecord } from '../interfaces.js';

/**
 * Deterministic successor selection (Decision 7).
 * Pure function — no DB access, no side effects.
 *
 * Tiebreaker order:
 *   1. Highest heartbeatStreak (DESC)
 *   2. Earliest registeredAt (ASC — longer-standing backup wins)
 *   3. Lexicographically lowest teeInstanceId (ASC — deterministic final tiebreaker)
 *
 * Guardians applying this rule against identical DB snapshots always converge
 * on the same target. Coordination-free by construction.
 */
export function selectSuccessor(backupAgents: BackupAgentRecord[]): BackupAgentRecord | null {
  const standby = backupAgents.filter(a => a.status === 'standby');
  if (standby.length === 0) return null;

  standby.sort((a, b) => {
    // 1. Highest heartbeatStreak first
    if (b.heartbeatStreak !== a.heartbeatStreak) {
      return b.heartbeatStreak - a.heartbeatStreak;
    }
    // 2. Earliest registeredAt first
    const aTime = a.registeredAt.getTime();
    const bTime = b.registeredAt.getTime();
    if (aTime !== bTime) {
      return aTime - bTime;
    }
    // 3. Lexicographically lowest teeInstanceId first
    return a.teeInstanceId.localeCompare(b.teeInstanceId);
  });

  return standby[0];
}
