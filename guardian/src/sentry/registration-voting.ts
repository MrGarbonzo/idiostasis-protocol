/**
 * Registration Voting — handle agent registration proposals.
 *
 * When an agent requests registration:
 *   1. Verify the attestation
 *   2. Check the code hash against approved list
 *   3. Create an agent_registration proposal (75% threshold, 1h deadline)
 *   4. If proposal passes → register the agent in the registry
 *
 * For fast turnaround, agent_registration proposals have a 1-hour deadline
 * and require 75% approval by pool value.
 */
import type Database from 'better-sqlite3';
import type { RegistryClient, RegistrationRequest } from '../shared/registry-types.js';
import {
  verifyAttestation,
  deserializeAttestation,
} from '../shared/attestation.js';
import { ProposalManager } from './proposals.js';
import { VotingSystem } from './voting.js';
import type { ApprovedCode } from './agent-verification.js';
import type { TrustStore } from '../shared/trust-store.js';

export interface RegistrationRequestResult {
  success: boolean;
  proposalId?: string;
  error?: string;
}

export class RegistrationVoting {
  private db: Database.Database;
  private registry: RegistryClient;
  private proposals: ProposalManager;
  private voting: VotingSystem;
  private approvedCode: ApprovedCode;
  /** When true, skip proposal and register immediately (single-sentry mode). */
  private autoApprove: boolean;
  private trustStore?: TrustStore;

  constructor(
    db: Database.Database,
    registry: RegistryClient,
    proposals: ProposalManager,
    voting: VotingSystem,
    approvedCode: ApprovedCode,
    opts?: { autoApprove?: boolean; trustStore?: TrustStore },
  ) {
    this.db = db;
    this.registry = registry;
    this.proposals = proposals;
    this.voting = voting;
    this.approvedCode = approvedCode;
    this.autoApprove = opts?.autoApprove ?? false;
    this.trustStore = opts?.trustStore;
  }

  /**
   * Handle an incoming agent registration request.
   * Creates a proposal for guardians to vote on.
   */
  async handleRegistrationRequest(
    request: RegistrationRequest,
  ): Promise<RegistrationRequestResult> {
    // Step 1: Check if another agent is already active
    const current = await this.registry.getCurrentAgent();
    if (current?.isActive) {
      return {
        success: false,
        error: `Another agent is already active: ${current.teeInstanceId}`,
      };
    }

    // Step 2: Verify the attestation
    if (request.attestation) {
      try {
        const attestation = deserializeAttestation(request.attestation);
        const verification = verifyAttestation(attestation, {
          maxAgeSeconds: 300,
        });
        if (!verification.valid) {
          return {
            success: false,
            error: `Attestation verification failed: ${verification.error}`,
          };
        }
      } catch {
        return { success: false, error: 'Invalid attestation format' };
      }
    }

    // Step 3: Check code hash
    if (!this.approvedCode.isApproved(request.codeHash)) {
      return {
        success: false,
        error: `Code hash not approved: ${request.codeHash}`,
      };
    }

    // Step 4: Auto-approve or create proposal
    if (this.autoApprove) {
      const result = await this.registry.registerAgent(request);
      if (!result.success) {
        return { success: false, error: `Registry rejected: ${result.error}` };
      }
      this.addAgentToTrustStore(request);
      console.log(`[Registration] Auto-approved agent ${request.teeInstanceId.slice(0, 12)}...`);
      return { success: true };
    }

    // Multi-sentry mode: create an agent_registration proposal
    const proposalId = this.proposals.create({
      type: 'agent_registration',
      proposer: request.teeInstanceId,
      description: `Register agent TEE=${request.teeInstanceId.slice(0, 12)}... code=${request.codeHash.slice(0, 12)}...`,
      data: {
        teeInstanceId: request.teeInstanceId,
        codeHash: request.codeHash,
        endpoint: request.endpoint,
      },
    });

    return { success: true, proposalId };
  }

  /**
   * Execute a passed agent_registration proposal.
   * Called after the proposal reaches 75% approval.
   */
  async executeRegistration(proposalId: string): Promise<{ success: boolean; error?: string }> {
    const proposal = this.proposals.getById(proposalId);
    if (!proposal) return { success: false, error: 'Proposal not found' };
    if (proposal.status !== 'passed') return { success: false, error: `Proposal is ${proposal.status}` };
    if (proposal.type !== 'agent_registration') {
      return { success: false, error: 'Not an agent_registration proposal' };
    }
    if (!proposal.data) return { success: false, error: 'No registration data' };

    const data = JSON.parse(proposal.data) as RegistrationRequest;

    // Register the agent
    const result = await this.registry.registerAgent(data);
    if (!result.success) {
      return { success: false, error: `Registry rejected: ${result.error}` };
    }

    this.addAgentToTrustStore(data);
    console.log(`[Registration] Agent ${data.teeInstanceId.slice(0, 12)}... registered`);
    return { success: true };
  }

  /**
   * Add a registered agent to the trust store so DB sync can verify its identity.
   */
  private addAgentToTrustStore(request: RegistrationRequest): void {
    if (!this.trustStore) return;
    if (!request.ed25519PubkeyBase64 || !request.x25519PubkeyBase64) {
      console.warn(`[Registration] Agent ${request.teeInstanceId.slice(0, 12)}... missing keys, skipping trust store`);
      return;
    }

    const now = Date.now();
    this.trustStore.addPeer({
      id: request.teeInstanceId,
      ed25519PubkeyBase64: request.ed25519PubkeyBase64,
      x25519PubkeyBase64: request.x25519PubkeyBase64,
      attestedAt: now,
      lastVerified: now,
      isSentry: false,
    });
    console.log(`[Registration] Added agent ${request.teeInstanceId.slice(0, 12)}... to trust store`);
  }

  /**
   * Auto-resolve registration proposals and execute if passed.
   * Called by the background job.
   */
  async resolveRegistrationProposals(totalPoolValue: number): Promise<number> {
    const active = this.proposals.listByStatus('active');
    const registrationProposals = active.filter(
      (p) => p.type === 'agent_registration' && new Date(p.deadline) <= new Date(),
    );

    let resolved = 0;
    for (const proposal of registrationProposals) {
      const tally = this.voting.resolve(proposal.id, totalPoolValue);
      if (tally.passed) {
        await this.executeRegistration(proposal.id);
      }
      resolved++;
    }

    return resolved;
  }
}
