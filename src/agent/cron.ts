import { readFileSync } from 'fs';
import cron from 'node-cron';
import type { ServiceContext, DiscoveredGuardian } from './context.js';
import type { VaultClient } from './vault-client.js';
import { loadAttestationQuote } from './tee-signing.js';
import type { ERC8004RegistryClient } from '../registry/erc8004-registry-client.js';

interface CronConfig {
  /** VaultClient for encrypted DB snapshots. */
  vaultClient?: VaultClient;
  /** Live map of discovered guardians. */
  discoveredGuardians?: Map<string, DiscoveredGuardian>;
  /** Path to the agent's SQLite database file. */
  dbPath?: string;
  /** ERC-8004 registry client for on-chain heartbeats. */
  registryClient?: ERC8004RegistryClient;
  /** Agent's external endpoint URL for registry updates. */
  agentEndpoint?: string;
  /** TEE instance ID for encrypted registry fields. */
  teeInstanceId?: string;
  /** Ed25519 pubkey (base64) for registry self-registration retry. */
  ed25519Pubkey?: string;
  /** Code hash for registry self-registration retry. */
  codeHash?: string;
  /** Mutable flag: whether this agent is registered on-chain. */
  registeredOnChain?: { value: boolean };
}

export function startCronJobs(ctx: ServiceContext, config: CronConfig): void {

  // ── Health check: every 10 minutes ───────────────────────────
  cron.schedule('*/10 * * * *', async () => {
    console.log('[cron] Running health check...');
    try {
      ctx.db.verifyInvariants();
      console.log('[cron] Health check passed');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[cron] Invariants FAILED:', msg);
    }
  });

  // ── DB sync to guardians: every 10 minutes ───────────────────
  if (config.vaultClient?.hasVaultKey && config.discoveredGuardians && config.dbPath) {
    const vc = config.vaultClient;
    const guardians = config.discoveredGuardians;
    const dbPath = config.dbPath;

    cron.schedule('*/10 * * * *', async () => {
      console.log('[cron] Running DB sync...');
      try {
        const dbBuffer = readFileSync(dbPath);
        const attestationQuote = loadAttestationQuote() ?? undefined;
        const envelope = await vc.createSnapshot(dbBuffer, attestationQuote);
        let ok = 0;
        for (const [addr, g] of guardians) {
          try {
            const res = await fetch(`${g.endpoint.replace(/\/$/, '')}/api/db/snapshot`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(envelope),
              signal: AbortSignal.timeout(30_000),
            });
            const result = await res.json() as { accepted: boolean };
            if (result.accepted) ok++;
          } catch (err) {
            console.warn(`[cron] DB sync to ${addr} failed: ${err instanceof Error ? err.message : err}`);
          }
        }
        console.log(`[cron] DB sync complete: ${ok}/${guardians.size} guardians accepted`);
      } catch (err) {
        console.error('[cron] DB sync failed:', err);
      }
    });

    console.log('[cron] Scheduled: health-check (10min), db-sync (10min)');
  } else {
    console.log('[cron] Scheduled: health-check (10min)');
    if (!config.vaultClient?.hasVaultKey) {
      console.log('[cron] DB sync skipped: no vault key');
    }
  }

  // ── Registry heartbeat + re-discovery: every 5 minutes ──────
  if (config.registryClient) {
    const registry = config.registryClient;
    const guardians = config.discoveredGuardians;

    cron.schedule('*/5 * * * *', async () => {
      // Retry self-registration if not yet registered (skip if no endpoint known)
      if (config.registeredOnChain && !config.registeredOnChain.value) {
        if (!config.agentEndpoint) {
          console.log('[cron] Skipping registry retry — no endpoint set yet (waiting for /api/set-hostname)');
          return;
        }
        try {
          await registry.registerSelf({
            entityType: 'agent',
            endpoint: config.agentEndpoint,
            teeInstanceId: config.teeInstanceId ?? '',
            codeHash: config.codeHash ?? '',
            attestationHash: '',
            ed25519Pubkey: config.ed25519Pubkey ?? '',
            isActive: true,
          });
          config.registeredOnChain.value = true;
          console.log('[cron] Registry self-registration succeeded (retry)');
          return; // skip heartbeat this tick, next tick will heartbeat
        } catch (err) {
          console.warn(`[cron] Registry self-registration retry failed: ${err instanceof Error ? err.message : err}`);
          return; // no point in heartbeat/endpoint update if not registered
        }
      }

      // Heartbeat
      try {
        await registry.sendHeartbeat();
        console.log('[cron] ERC-8004 registry heartbeat sent');
      } catch (err) {
        console.warn(`[cron] Registry heartbeat failed: ${err instanceof Error ? err.message : err}`);
      }

      // Re-post endpoint (survives IP changes)
      if (config.agentEndpoint) {
        try {
          await registry.updateEndpoint(config.agentEndpoint);
          console.log('[cron] ERC-8004 registry endpoint updated');
        } catch (err) {
          console.warn(`[cron] Registry endpoint update failed: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Re-discover guardians (picks up new registrations)
      if (guardians) {
        try {
          const entries = await registry.getGuardians();
          let added = 0;
          for (const entry of entries) {
            if (!entry.isActive) continue;
            if (guardians.has(entry.teeInstanceId)) {
              // Update endpoint if changed
              const existing = guardians.get(entry.teeInstanceId)!;
              if (existing.endpoint !== entry.endpoint) {
                existing.endpoint = entry.endpoint;
                existing.lastSeen = Date.now();
              }
              continue;
            }
            guardians.set(entry.teeInstanceId, {
              address: entry.teeInstanceId,
              endpoint: entry.endpoint,
              isSentry: true,
              discoveredAt: Date.now(),
              lastSeen: Date.now(),
              verified: false, // Will be verified on next interaction
            });
            added++;
          }
          if (added > 0) {
            console.log(`[cron] Re-discovered ${added} new guardian(s) from registry`);
          }
        } catch (err) {
          console.warn(`[cron] Registry re-discovery failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    });
    console.log('[cron] Scheduled: registry-heartbeat + re-discovery (5min)');
  }
}
