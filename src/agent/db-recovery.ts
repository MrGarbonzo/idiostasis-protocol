/**
 * Database Recovery — fetch the latest DB snapshot from guardians.
 *
 * When a backup agent wins registration, it needs the current database
 * to start operating. The guardian network stores periodic backups.
 *
 * Recovery flow:
 *   1. Authenticate with guardian using TEE attestation
 *   2. Request latest backup via /api/recovery
 *   3. Write the backup to disk
 *   4. Return the path for the agent to use
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TEEIdentity } from './tee.js';
import {
  generateAttestation,
  serializeAttestation,
} from './attestation-utils.js';

export interface RecoveryConfig {
  guardianEndpoint: string;
  teeIdentity: TEEIdentity;
  outputDir: string;
}

export interface RecoveryResult {
  success: boolean;
  dbPath?: string;
  backupId?: number;
  backupTimestamp?: number;
  sizeBytes?: number;
  error?: string;
}

/**
 * Recover the fund manager database from a guardian node.
 */
export async function recoverDatabase(config: RecoveryConfig): Promise<RecoveryResult> {
  const endpoint = config.guardianEndpoint.replace(/\/$/, '');

  // Generate attestation to prove we're a registered agent
  const attestation = generateAttestation(
    config.teeIdentity.instanceId,
    config.teeIdentity.codeHash,
  );

  console.log('[Recovery] Requesting database from guardian...');

  try {
    const res = await fetch(`${endpoint}/api/recovery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: config.teeIdentity.instanceId,
        attestation: serializeAttestation(attestation),
      }),
      signal: AbortSignal.timeout(60_000), // Large timeout for big DBs
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return {
        success: false,
        error: `Guardian returned ${res.status}: ${body.error ?? 'unknown'}`,
      };
    }

    const result = (await res.json()) as {
      success: boolean;
      backup?: {
        id: number;
        timestamp: number;
        data: string; // base64
        sizeBytes: number;
        fundManagerId: string;
      };
      error?: string;
    };

    if (!result.success || !result.backup) {
      return { success: false, error: result.error ?? 'No backup data in response' };
    }

    // Decode and write the database file
    const dbData = Buffer.from(result.backup.data, 'base64');

    // Ensure output directory exists
    if (!existsSync(config.outputDir)) {
      mkdirSync(config.outputDir, { recursive: true });
    }

    const dbPath = join(config.outputDir, 'fund_manager.db');
    writeFileSync(dbPath, dbData);

    console.log(
      `[Recovery] Database recovered: ${dbPath} (${result.backup.sizeBytes} bytes, backup #${result.backup.id})`,
    );

    return {
      success: true,
      dbPath,
      backupId: result.backup.id,
      backupTimestamp: result.backup.timestamp,
      sizeBytes: result.backup.sizeBytes,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Try multiple guardians for recovery (fallback strategy).
 * Tries each endpoint in order until one succeeds.
 */
export async function recoverFromMultipleGuardians(
  guardianEndpoints: string[],
  teeIdentity: TEEIdentity,
  outputDir: string,
): Promise<RecoveryResult> {
  for (const endpoint of guardianEndpoints) {
    console.log(`[Recovery] Trying guardian: ${endpoint}`);
    const result = await recoverDatabase({
      guardianEndpoint: endpoint,
      teeIdentity,
      outputDir,
    });

    if (result.success) return result;
    console.warn(`[Recovery] Failed from ${endpoint}: ${result.error}`);
  }

  return {
    success: false,
    error: `All ${guardianEndpoints.length} guardians failed`,
  };
}
