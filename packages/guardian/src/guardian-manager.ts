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
  private static readonly STARTUP_DELAY_MS = 30 * 60 * 1000;
  private static readonly DEFICIT_DELAY_MS = 10 * 60 * 1000;

  private readonly db: ProtocolDatabase;
  private readonly config: ProtocolConfig;
  private readonly secretvmClient: SecretVmClient;
  private readonly startedAt: number = Date.now();

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
    // GUARD 1 — backup RTMR3 must be locked
    const backupRtmr3Locked = this.db.getConfig('backup_rtmr3');
    if (!backupRtmr3Locked) {
      console.log('[guardian-manager] backup RTMR3 not yet locked — skipping');
      return;
    }

    // GUARD 2 — 30 minute startup delay
    if (Date.now() - this.startedAt < AutonomousGuardianManager.STARTUP_DELAY_MS) {
      const remaining = Math.round((AutonomousGuardianManager.STARTUP_DELAY_MS - (Date.now() - this.startedAt)) / 60_000);
      console.log(`[guardian-manager] startup delay — ${remaining}min remaining`);
      return;
    }

    const failureThresholdMs = this.config.livenessFailureThreshold * this.config.heartbeatIntervalMs;
    const allGuardians = this.db.listGuardians();

    // Count total active guardians
    const allActive = allGuardians.filter(g => g.status === 'active');
    const totalActive = allActive.length;

    // Count external stable guardians
    const externalStableCount = allGuardians.filter(g =>
      g.provisionedBy === 'external' &&
      g.status === 'active' &&
      (Date.now() - g.lastSeenAt.getTime()) < failureThresholdMs,
    ).length;

    // Agent-provisioned active guardians
    const agentGuardians = allGuardians.filter(
      g => g.provisionedBy === 'agent' && g.status === 'active',
    );

    // --- GUARDIAN PROVISIONING ---

    if (totalActive < 2) {
      // Don't provision if we already have a pending VM
      const pendingVmId = this.db.getConfig('guardian_provisioning_pending');
      if (pendingVmId) {
        console.log(`[guardian-manager] guardian VM ${pendingVmId.slice(0, 8)} pending admission — waiting`);
      } else {
        const deficitSince = this.db.getConfig('guardian_deficit_since');
        if (!deficitSince) {
          this.db.setConfig('guardian_deficit_since', String(Date.now()));
          console.log(`[guardian-manager] guardian deficit detected (${totalActive}/2) — waiting 10min`);
        } else {
          const elapsed = Date.now() - parseInt(deficitSince, 10);
          if (elapsed >= AutonomousGuardianManager.DEFICIT_DELAY_MS) {
            const needed = 2 - totalActive;
            console.log(`[guardian-manager] guardian deficit persisted 10min — provisioning ${needed}`);
            for (let i = 0; i < needed; i++) {
              await this.provisionGuardian();
            }
            this.db.setConfig('guardian_deficit_since', '');
          }
        }
      }
    } else {
      // Reset deficit timer and pending flag when recovered
      this.db.setConfig('guardian_deficit_since', '');
      this.db.setConfig('guardian_provisioning_pending', '');

      // RULE 2 — spin down excess agent guardians if total > 3 and external >= 2
      if (totalActive > 3 && externalStableCount >= 2) {
        const toRemove = totalActive - 3;
        console.log(`[guardian-manager] ${totalActive} guardians, spinning down ${toRemove} agent guardian(s)`);
        for (let i = 0; i < toRemove && i < agentGuardians.length; i++) {
          await this.deprovisionGuardian(agentGuardians[i]);
        }
      }
    }

    // --- BACKUP PROVISIONING ---

    const backups = this.db.listBackupAgents('standby');
    const totalBackups = backups.length;
    const agentBackupVmId = this.db.getConfig('agent_backup_vm_id');

    if (totalBackups === 0) {
      const pendingBackupVmId = this.db.getConfig('backup_provisioning_pending');
      if (pendingBackupVmId) {
        console.log(`[guardian-manager] backup VM ${pendingBackupVmId.slice(0, 8)} pending admission — waiting`);
      } else {
        const backupDeficitSince = this.db.getConfig('backup_deficit_since');
        if (!backupDeficitSince) {
          this.db.setConfig('backup_deficit_since', String(Date.now()));
          console.log('[guardian-manager] no backup agents — waiting 10min before provisioning');
        } else {
          const elapsed = Date.now() - parseInt(backupDeficitSince, 10);
          if (elapsed >= AutonomousGuardianManager.DEFICIT_DELAY_MS) {
            console.log('[guardian-manager] backup deficit persisted 10min — provisioning backup');
            await this.provisionBackup();
            this.db.setConfig('backup_deficit_since', '');
          }
        }
      }
    } else {
      // Reset backup deficit timer and pending flag
      this.db.setConfig('backup_deficit_since', '');
      this.db.setConfig('backup_provisioning_pending', '');

      // RULE 5 — stop agent backup if 2+ other backups exist
      if (totalBackups >= 2 && agentBackupVmId) {
        console.log(`[guardian-manager] ${totalBackups} backups running — stopping agent backup`);
        await this.stopBackup(agentBackupVmId);
      }
    }
  }

  private async provisionGuardian(): Promise<void> {
    const composeYaml = this.db.getConfig('guardian_compose');
    if (!composeYaml) {
      throw new Error('guardian_compose not found in DB — agent may not have stored it yet');
    }
    const composeBytes = new TextEncoder().encode(composeYaml);

    console.log(`[guardian-manager] using guardian compose from DB (${composeBytes.length} bytes)`);

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
    this.db.setConfig('guardian_provisioning_pending', result.vmId);
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
    const composeYaml = this.db.getConfig('agent_compose');
    if (!composeYaml) {
      throw new Error('agent_compose not found in DB — agent may not have stored it yet');
    }
    const composeBytes = new TextEncoder().encode(composeYaml);

    console.log(`[guardian-manager] using agent compose from DB (${composeBytes.length} bytes)`);

    const result = await this.secretvmClient.createVm({
      name: `backup-agent-${Date.now()}`,
      dockerCompose: composeBytes,
    });

    this.db.setConfig('agent_backup_vm_id', result.vmId);
    this.db.setConfig('backup_provisioning_pending', result.vmId);
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
