import {
  ProtocolDatabase,
  ProtocolEventType,
} from '@idiostasis/core';
import type {
  ProtocolConfig,
  GuardianRecord,
} from '@idiostasis/core';

export interface CreateVmParams {
  name: string;
  dockerCompose: Uint8Array;
}

export interface SecretVmClient {
  createVm(params: CreateVmParams): Promise<{ vmId: string; domain: string }>;
  getVmStatus(vmId: string): Promise<{ status: string }>;
  stopVm(vmId: string): Promise<void>;
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export class AutonomousGuardianManager {
  private readonly db: ProtocolDatabase;
  private readonly config: ProtocolConfig;
  private readonly secretvmClient: SecretVmClient;

  constructor(
    db: ProtocolDatabase,
    config: ProtocolConfig,
    secretvmClient: SecretVmClient,
  ) {
    this.db = db;
    this.config = config;
    this.secretvmClient = secretvmClient;
  }

  async evaluate(): Promise<void> {
    const allGuardians = this.db.listGuardians();

    // Count external stable guardians (Decision 8):
    // external, active, and NOT crossing liveness failure threshold
    const externalStable = allGuardians.filter(g => {
      if (g.provisionedBy !== 'external') return false;
      if (g.status !== 'active') return false;
      // Check if guardian has NOT crossed liveness failure threshold
      const msSinceLastSeen = Date.now() - g.lastSeenAt.getTime();
      const failureThresholdMs = this.config.livenessFailureThreshold * this.config.heartbeatIntervalMs;
      return msSinceLastSeen < failureThresholdMs;
    });

    const externalStableCount = externalStable.length;
    // Find an active agent guardian (inactive ones have been deprovisioned)
    const agentGuardian = allGuardians.find(g => g.provisionedBy === 'agent' && g.status === 'active');

    if (externalStableCount < 2) {
      // Reset 24-hour clock
      this.db.setConfig('external_stable_since', '');

      // Ensure agent guardian is running
      if (!agentGuardian) {
        await this.provisionGuardian();
      } else {
        // Check if it's running
        try {
          if (agentGuardian.agentVmId) {
            const vmStatus = await this.secretvmClient.getVmStatus(agentGuardian.agentVmId);
            if (vmStatus.status !== 'running') {
              await this.restartGuardian(agentGuardian);
            }
          }
        } catch {
          // VM status check failed — try to restart
          await this.restartGuardian(agentGuardian);
        }
      }
    } else {
      // externalStable >= 2
      const stableSince = this.db.getConfig('external_stable_since');

      if (!stableSince) {
        this.db.setConfig('external_stable_since', String(Date.now()));
      } else {
        const stableSinceMs = parseInt(stableSince, 10);
        if (!Number.isNaN(stableSinceMs) && (Date.now() - stableSinceMs) >= TWENTY_FOUR_HOURS_MS) {
          // 24 hours of stability — deprovision agent guardian if active
          if (agentGuardian && agentGuardian.status === 'active') {
            await this.deprovisionGuardian(agentGuardian);
          }
        }
      }
    }
  }

  private async provisionGuardian(): Promise<void> {
    const composeUrl = process.env.GUARDIAN_COMPOSE_URL
      ?? 'https://raw.githubusercontent.com/MrGarbonzo/idiostasis-protocol/main/docker/docker-compose.secretvm-guardian.yml';

    const res = await fetch(composeUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Failed to fetch guardian compose: ${res.status}`);
    const composeYaml = await res.text();
    const composeBytes = new TextEncoder().encode(composeYaml);

    console.log(`[guardian-manager] fetched guardian compose (${composeBytes.length} bytes)`);

    const result = await this.secretvmClient.createVm({
      name: `guardian-agent-${Date.now()}`,
      dockerCompose: composeBytes,
    });

    const now = new Date();
    const record: GuardianRecord = {
      id: `agent-guardian-${result.vmId}`,
      networkAddress: `${result.domain}:8080`,
      teeInstanceId: `tee-${result.vmId}`,
      rtmr3: '',
      admittedAt: now,
      lastAttestedAt: now,
      lastSeenAt: now,
      status: 'active',
      provisionedBy: 'agent',
      agentVmId: result.vmId,
    };
    this.db.upsertGuardian(record);
    this.db.logEvent(ProtocolEventType.GUARDIAN_PROVISIONED, `vm:${result.vmId}`);
  }

  private async restartGuardian(guardian: GuardianRecord): Promise<void> {
    if (!guardian.agentVmId) {
      await this.provisionGuardian();
      return;
    }

    try {
      const status = await this.secretvmClient.getVmStatus(guardian.agentVmId);
      if (status.status === 'not_found') {
        // VM no longer exists — reprovision
        await this.provisionGuardian();
        return;
      }
    } catch {
      // VM doesn't exist — reprovision
      await this.provisionGuardian();
      return;
    }

    console.warn(`[guardian-manager] restarting agent guardian VM ${guardian.agentVmId}`);
  }

  private async deprovisionGuardian(guardian: GuardianRecord): Promise<void> {
    if (guardian.agentVmId) {
      await this.secretvmClient.stopVm(guardian.agentVmId);
    }

    this.db.upsertGuardian({
      ...guardian,
      status: 'inactive',
    });

    this.db.logEvent(ProtocolEventType.GUARDIAN_DEPROVISIONED, `vm:${guardian.agentVmId}`);
  }
}
