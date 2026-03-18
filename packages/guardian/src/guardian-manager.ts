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
    const failureThresholdMs = this.config.livenessFailureThreshold * this.config.heartbeatIntervalMs;

    // Count all active guardians (external + agent-provisioned)
    const allActive = allGuardians.filter(g => g.status === 'active');
    const totalActive = allActive.length;

    // Count external stable guardians separately
    const externalStable = allGuardians.filter(g =>
      g.provisionedBy === 'external' &&
      g.status === 'active' &&
      (Date.now() - g.lastSeenAt.getTime()) < failureThresholdMs,
    );
    const externalStableCount = externalStable.length;

    // Find agent-provisioned active guardians
    const agentGuardians = allGuardians.filter(
      g => g.provisionedBy === 'agent' && g.status === 'active',
    );

    // RULE 1 — If totalActive < 2, provision guardians until we have 2
    if (totalActive < 2) {
      const needed = 2 - totalActive;
      console.log(`[guardian-manager] network has ${totalActive} guardians — provisioning ${needed} more`);
      for (let i = 0; i < needed; i++) {
        await this.provisionGuardian();
      }
    }

    // RULE 2 — If totalActive > 3 AND externalStable >= 2, spin down agent guardians
    if (totalActive > 3 && externalStableCount >= 2) {
      const toRemove = Math.min(totalActive - 3, agentGuardians.length);
      console.log(`[guardian-manager] ${totalActive} guardians running, ${externalStableCount} external stable — spinning down ${toRemove} agent guardian(s)`);
      for (let i = 0; i < toRemove; i++) {
        await this.deprovisionGuardian(agentGuardians[i]);
      }
    }

    // --- Backup agent rules ---

    const backups = this.db.listBackupAgents('standby');
    const totalBackups = backups.length;
    const agentBackupVmId = this.db.getConfig('agent_backup_vm_id');

    // RULE 4 — If no backups, provision one
    if (totalBackups === 0) {
      if (!agentBackupVmId) {
        console.log('[guardian-manager] no backup agents — provisioning one');
        await this.provisionBackup();
      }
    }

    // RULE 5 — If 2+ backups and we have an agent backup, stop it
    if (totalBackups >= 2 && agentBackupVmId) {
      console.log(`[guardian-manager] ${totalBackups} backups running — stopping agent backup`);
      await this.stopBackup(agentBackupVmId);
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

  private async provisionBackup(): Promise<void> {
    const composeUrl = process.env.BACKUP_COMPOSE_URL
      ?? 'https://raw.githubusercontent.com/MrGarbonzo/idiostasis-protocol/main/docker/docker-compose.secretvm-agent.yml';

    const res = await fetch(composeUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Failed to fetch backup compose: ${res.status}`);
    const composeYaml = await res.text();
    const composeBytes = new TextEncoder().encode(composeYaml);

    console.log(`[guardian-manager] fetched backup compose (${composeBytes.length} bytes)`);

    const result = await this.secretvmClient.createVm({
      name: `backup-agent-${Date.now()}`,
      dockerCompose: composeBytes,
    });

    this.db.setConfig('agent_backup_vm_id', result.vmId);
    console.log(`[guardian-manager] provisioned backup agent VM ${result.vmId}`);
  }

  private async stopBackup(vmId: string): Promise<void> {
    await this.secretvmClient.stopVm(vmId);
    this.db.setConfig('agent_backup_vm_id', '');
    console.log(`[guardian-manager] stopped agent backup VM ${vmId}`);
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
