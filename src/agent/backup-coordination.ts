/**
 * Backup Coordination — orchestrate takeover when primary agent fails.
 *
 * Takeover timeline:
 *   T+0:      Primary crashes
 *   T+5min:   Heartbeat timeout (300s), registry deactivates agent
 *   T+5-5.5m: Backups detect, add random delay (0-30s)
 *   T+5.5m:   First backup requests registration
 *   T+5.5m:   Guardians vote (75% threshold, instant for pre-approved code)
 *   T+5.5m:   Backup registered, fetches DB from guardians
 *   T+6m:     Backup starts operating
 *
 * Safety: Backups CAN'T double-trade because:
 *   - They have no database
 *   - They aren't registered
 *   - Only after winning registration AND receiving DB can they trade
 */
import type { TEEIdentity } from './tee.js';
import {
  generateAttestation,
  serializeAttestation,
} from './attestation-utils.js';
import { recoverDatabase } from './db-recovery.js';
import type { ERC8004RegistryClient } from '../registry/erc8004-registry-client.js';

/** Max random delay in milliseconds to reduce collision between backups. */
const MAX_JITTER_MS = 30_000;

/** Delay between registration retry attempts. */
const RETRY_DELAY_MS = 10_000;

/** Maximum number of registration attempts before giving up this cycle. */
const MAX_ATTEMPTS = 3;

export type TakeoverResult =
  | { outcome: 'success'; dbPath: string }
  | { outcome: 'lost_race'; activeAgent: string }
  | { outcome: 'failed'; error: string };

export interface TakeoverConfig {
  guardianEndpoint: string;
  teeIdentity: TEEIdentity;
  /** Directory to write recovered database to. */
  dbDir: string;
  /** This backup agent's own endpoint (for registration). */
  ownEndpoint?: string;
  /** Ed25519 pubkey base64 (for trust store). */
  ed25519PubkeyBase64?: string;
}

/**
 * Attempt to take over from a failed primary agent.
 *
 * Steps:
 *   1. Wait a random delay (0-30s) to reduce collision
 *   2. Re-check registry (another backup may have already registered)
 *   3. Request registration with guardian approval
 *   4. If approved: fetch database from guardians
 *   5. Return result (success with dbPath, or lost_race/failed)
 */
export async function attemptTakeover(config: TakeoverConfig): Promise<TakeoverResult> {
  const endpoint = config.guardianEndpoint.replace(/\/$/, '');

  // Step 1: Random jitter to reduce collision
  const jitterMs = Math.floor(Math.random() * MAX_JITTER_MS);
  console.log(`[Takeover] Waiting ${(jitterMs / 1000).toFixed(1)}s jitter before attempting`);
  await sleep(jitterMs);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`[Takeover] Attempt ${attempt}/${MAX_ATTEMPTS}`);

    // Step 2: Re-check registry — another backup may have won
    const checkResult = await checkRegistry(endpoint);
    if (checkResult.anotherAgentActive) {
      console.log(`[Takeover] Another agent already registered: ${checkResult.activeAgentId}`);
      return { outcome: 'lost_race', activeAgent: checkResult.activeAgentId! };
    }

    // Step 3: Request registration
    const regResult = await requestRegistration(
      endpoint, config.teeIdentity, config.ownEndpoint, config.ed25519PubkeyBase64,
    );
    if (regResult.success) {
      console.log('[Takeover] Registration successful — fetching database');

      // Step 4: Fetch database from guardians
      const dbResult = await recoverDatabase({
        guardianEndpoint: endpoint,
        teeIdentity: config.teeIdentity,
        outputDir: config.dbDir,
      });

      if (dbResult.success) {
        console.log(`[Takeover] Database recovered: ${dbResult.dbPath}`);
        return { outcome: 'success', dbPath: dbResult.dbPath! };
      }

      // DB recovery failed — can't start with no data
      // Return failure so the caller retries instead of starting empty
      console.warn(`[Takeover] DB recovery failed: ${dbResult.error}`);
      return { outcome: 'failed', error: `DB recovery failed: ${dbResult.error}` };
    }

    if (regResult.lost) {
      return { outcome: 'lost_race', activeAgent: regResult.activeAgent ?? 'unknown' };
    }

    console.warn(`[Takeover] Registration attempt ${attempt} failed: ${regResult.error}`);

    if (attempt < MAX_ATTEMPTS) {
      await sleep(RETRY_DELAY_MS);
    }
  }

  return { outcome: 'failed', error: `Failed after ${MAX_ATTEMPTS} attempts` };
}

/** Check if another agent has already registered. */
async function checkRegistry(
  endpoint: string,
): Promise<{ anotherAgentActive: boolean; activeAgentId: string | null }> {
  try {
    const res = await fetch(`${endpoint}/api/sentry/agent/current`, {
      signal: AbortSignal.timeout(5_000),
    });

    if (res.status === 404) {
      return { anotherAgentActive: false, activeAgentId: null };
    }

    if (res.ok) {
      const agent = (await res.json()) as { teeInstanceId: string; isActive: boolean };
      if (agent.isActive) {
        return { anotherAgentActive: true, activeAgentId: agent.teeInstanceId };
      }
    }

    return { anotherAgentActive: false, activeAgentId: null };
  } catch {
    return { anotherAgentActive: false, activeAgentId: null };
  }
}

/** Request registration with the guardian network. */
async function requestRegistration(
  endpoint: string,
  teeIdentity: TEEIdentity,
  ownEndpoint?: string,
  ed25519PubkeyBase64?: string,
): Promise<{ success: boolean; lost?: boolean; activeAgent?: string; error?: string }> {
  try {
    const attestation = generateAttestation(teeIdentity.instanceId, teeIdentity.codeHash);

    const res = await fetch(`${endpoint}/api/sentry/agent/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        teeInstanceId: teeIdentity.instanceId,
        codeHash: teeIdentity.codeHash,
        attestation: serializeAttestation(attestation),
        endpoint: ownEndpoint ?? 'pending',
        ed25519PubkeyBase64,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const result = (await res.json()) as { success: boolean; error?: string };

    if (result.success) {
      return { success: true };
    }

    // Check if the error indicates another agent won the race
    if (result.error?.includes('already active')) {
      return { success: false, lost: true, activeAgent: 'unknown' };
    }

    return { success: false, error: result.error };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Register the new agent on-chain after a successful takeover.
 * This updates the ERC-8004 registry so future guardians/backups can discover it.
 */
export async function registerSelfOnChain(opts: {
  registryClient: ERC8004RegistryClient;
  teeIdentity: TEEIdentity;
  endpoint: string;
  ed25519Pubkey: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const txHash = await opts.registryClient.registerSelf({
      entityType: 'agent',
      endpoint: opts.endpoint,
      teeInstanceId: opts.teeIdentity.instanceId,
      codeHash: opts.teeIdentity.codeHash,
      attestationHash: '',
      ed25519Pubkey: opts.ed25519Pubkey,
      isActive: true,
    });
    console.log(`[Takeover] Registered on-chain: ${txHash}`);
    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`[Takeover] On-chain registration failed (non-fatal): ${error}`);
    return { success: false, error };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wire standby mode with takeover coordination.
 *
 * This is the main entry point for a backup agent:
 *   1. Start in standby mode (monitoring registry)
 *   2. When primary fails → run takeover
 *   3. If takeover succeeds → return config for starting as primary
 *   4. If takeover fails → return to standby
 */
export async function runBackupAgent(config: {
  /** Guardian endpoint — optional. Guardian contacts us via /api/backup/ready. */
  guardianEndpoint?: string;
  dbDir: string;
  ownEndpoint?: string;
  ed25519PubkeyBase64?: string;
  /** Primary agent endpoint (discovered from ERC-8004 registry). Required. */
  primaryAgentEndpoint?: string;
}): Promise<{ dbPath: string; teeIdentity: TEEIdentity } | null> {
  // Import dynamically to avoid circular deps
  const { createAgentRegisteredStandby } = await import('./standby-mode.js');
  const { getTEEInstanceId } = await import('./tee.js');

  const teeIdentity = await getTEEInstanceId();
  let resolved = false;

  /** Takeover handler — only used if guardian endpoint is available. */
  let lastTakeoverDbPath = '';
  async function handlePrimaryFailure(): Promise<boolean> {
    if (resolved) return false;
    if (!config.guardianEndpoint) {
      console.log('[Backup] Primary failure detected but no guardian endpoint — waiting for guardian to contact us via /api/backup/ready');
      return false;
    }

    const result = await attemptTakeover({
      guardianEndpoint: config.guardianEndpoint,
      teeIdentity,
      dbDir: config.dbDir,
      ownEndpoint: config.ownEndpoint,
      ed25519PubkeyBase64: config.ed25519PubkeyBase64,
    });

    if (result.outcome === 'success') {
      resolved = true;
      lastTakeoverDbPath = result.dbPath;
      return true;
    }

    return false;
  }

  if (!config.primaryAgentEndpoint || !config.ownEndpoint || !config.ed25519PubkeyBase64) {
    console.log('[Backup] Missing primary endpoint or own identity — waiting for guardian-initiated takeover via /api/backup/ready');
    // Block forever — guardian will contact us at POST /api/backup/ready
    return new Promise(() => {});
  }

  console.log(`[Backup] Registering with primary at ${config.primaryAgentEndpoint}`);

  return new Promise((resolve) => {
    const registeredStandby = createAgentRegisteredStandby(
      config.primaryAgentEndpoint!,
      config.ed25519PubkeyBase64!,
      config.ownEndpoint!,
      {
        getGuardianEndpoint: () => config.guardianEndpoint ?? '',
        onPrimaryFailure: async () => {
          const took = await handlePrimaryFailure();
          if (took) {
            registeredStandby.stop();
            resolve({ dbPath: lastTakeoverDbPath, teeIdentity });
          }
          return took;
        },
        onBecamePrimary: async () => {
          console.log('[Backup] Became primary — exiting standby');
        },
        onLostRace: () => {
          console.log('[Backup] Lost race — returning to standby monitoring');
        },
      },
    );

    registeredStandby.start();
  });
}
