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

export interface NetworkManagerParams {
  db: ProtocolDatabase;
  config: ProtocolConfig;
  secretvmClient: SecretVmClient;
  getTvlUsdc: () => Promise<number>;
}

export class AutonomousNetworkManager {
  private static readonly STARTUP_DELAY_MS = 30 * 60 * 1000;
  private static readonly DEFICIT_DELAY_MS = 10 * 60 * 1000;

  private readonly db: ProtocolDatabase;
  private readonly config: ProtocolConfig;
  private readonly secretvmClient: SecretVmClient;
  private readonly getTvlUsdc: () => Promise<number>;
  private readonly startedAt: number = Date.now();

  constructor(params: NetworkManagerParams) {
    this.db = params.db;
    this.config = params.config;
    this.secretvmClient = params.secretvmClient;
    this.getTvlUsdc = params.getTvlUsdc;
  }

  async evaluate(): Promise<void> {
    // GUARD 1 — backup RTMR3 must be locked
    const backupRtmr3Locked = this.db.getConfig('backup_rtmr3');
    if (!backupRtmr3Locked) {
      console.log('[network-manager] backup RTMR3 not yet locked — skipping');
      return;
    }

    // GUARD 2 — 30 minute startup delay
    if (Date.now() - this.startedAt < AutonomousNetworkManager.STARTUP_DELAY_MS) {
      const remaining = Math.round((AutonomousNetworkManager.STARTUP_DELAY_MS - (Date.now() - this.startedAt)) / 60_000);
      console.log(`[network-manager] startup delay — ${remaining}min remaining`);
      return;
    }

    // Determine tier from TVL
    const tvl = await this.getTvlUsdc();
    const tier = tvl >= this.config.tvlTier1Usdc ? 'scaled' : 'base';
    const targetGuardians = tier === 'scaled' ? 2 : 1;
    const targetBackups = tier === 'scaled' ? 2 : 1;

    console.log(
      `[network-manager] TVL: $${tvl.toFixed(2)} USDC — tier: ${tier} (targets: ${targetGuardians} guardians, ${targetBackups} backups)`,
    );

    const failureThresholdMs = this.config.livenessFailureThreshold * this.config.heartbeatIntervalMs;
    const allGuardians = this.db.listGuardians();

    // Count total active guardians
    const allActive = allGuardians.filter(g => g.status === 'active');
    const totalActive = allActive.length;

    // Agent-provisioned active guardians
    const agentGuardians = allGuardians.filter(
      g => g.provisionedBy === 'agent' && g.status === 'active',
    );

    // --- GUARDIAN MANAGEMENT ---

    if (totalActive < targetGuardians) {
      const pendingVmId = this.db.getConfig('guardian_provisioning_pending');
      if (pendingVmId) {
        console.log(`[network-manager] guardian VM ${pendingVmId.slice(0, 8)} pending admission — waiting`);
      } else {
        const deficitSince = this.db.getConfig('guardian_deficit_since');
        if (!deficitSince) {
          this.db.setConfig('guardian_deficit_since', String(Date.now()));
          console.log(`[network-manager] guardian deficit detected (${totalActive}/${targetGuardians}) — waiting 10min`);
        } else {
          const elapsed = Date.now() - parseInt(deficitSince, 10);
          if (elapsed >= AutonomousNetworkManager.DEFICIT_DELAY_MS) {
            const needed = targetGuardians - totalActive;
            console.log(`[network-manager] guardian deficit persisted 10min — provisioning ${needed}`);
            for (let i = 0; i < needed; i++) {
              await this.provisionGuardian();
            }
            this.db.setConfig('guardian_deficit_since', '');
          }
        }
      }
    } else {
      this.db.setConfig('guardian_deficit_since', '');
      this.db.setConfig('guardian_provisioning_pending', '');

      // Spin down excess agent-provisioned guardians (never touch external ones)
      if (totalActive > targetGuardians && agentGuardians.length > 0) {
        const toRemove = Math.min(totalActive - targetGuardians, agentGuardians.length);
        console.log(`[network-manager] ${totalActive} guardians (target ${targetGuardians}), spinning down ${toRemove} agent guardian(s)`);
        for (let i = 0; i < toRemove; i++) {
          await this.deprovisionGuardian(agentGuardians[i]);
        }
      }
    }

    // --- BACKUP MANAGEMENT ---

    const backups = this.db.listBackupAgents('standby');
    const totalBackups = backups.length;

    if (totalBackups < targetBackups) {
      const pendingBackupVmId = this.db.getConfig('backup_provisioning_pending');
      if (pendingBackupVmId) {
        console.log(`[network-manager] backup VM ${pendingBackupVmId.slice(0, 8)} pending admission — waiting`);
      } else {
        const backupDeficitSince = this.db.getConfig('backup_deficit_since');
        if (!backupDeficitSince) {
          this.db.setConfig('backup_deficit_since', String(Date.now()));
          console.log(`[network-manager] backup deficit (${totalBackups}/${targetBackups}) — waiting 10min`);
        } else {
          const elapsed = Date.now() - parseInt(backupDeficitSince, 10);
          if (elapsed >= AutonomousNetworkManager.DEFICIT_DELAY_MS) {
            const needed = targetBackups - totalBackups;
            console.log(`[network-manager] backup deficit persisted 10min — provisioning ${needed}`);
            for (let i = 0; i < needed; i++) {
              await this.provisionBackup();
            }
            this.db.setConfig('backup_deficit_since', '');
          }
        }
      }
    } else {
      this.db.setConfig('backup_deficit_since', '');
      this.db.setConfig('backup_provisioning_pending', '');

      // Spin down excess agent-provisioned backups
      const agentBackupVmId = this.db.getConfig('agent_backup_vm_id');
      if (totalBackups > targetBackups && agentBackupVmId) {
        console.log(`[network-manager] ${totalBackups} backups (target ${targetBackups}) — stopping agent backup`);
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

    console.log(`[network-manager] using guardian compose from DB (${composeBytes.length} bytes)`);

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

  private async provisionBackup(): Promise<void> {
    const composeYaml = this.db.getConfig('agent_compose');
    if (!composeYaml) {
      throw new Error('agent_compose not found in DB — agent may not have stored it yet');
    }
    const composeBytes = new TextEncoder().encode(composeYaml);

    console.log(`[network-manager] using agent compose from DB (${composeBytes.length} bytes)`);

    const result = await this.secretvmClient.createVm({
      name: `backup-agent-${Date.now()}`,
      dockerCompose: composeBytes,
    });

    this.db.setConfig('agent_backup_vm_id', result.vmId);
    this.db.setConfig('backup_provisioning_pending', result.vmId);
    console.log(`[network-manager] provisioned backup agent VM ${result.vmId}`);
  }

  private async stopBackup(vmId: string): Promise<void> {
    await this.secretvmClient.stopVm(vmId);
    this.db.setConfig('agent_backup_vm_id', '');
    console.log(`[network-manager] stopped agent backup VM ${vmId}`);
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

/** @deprecated Use AutonomousNetworkManager */
export const AutonomousGuardianManager = AutonomousNetworkManager;
