import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../../src/shared/db.js';
import { LocalRegistryClient } from '../../src/shared/registry-client.js';
import { ProposalManager } from '../../src/sentry/proposals.js';
import { VotingSystem } from '../../src/sentry/voting.js';
import { DelegationTracker } from '../../src/guardian/delegations.js';
import { RegistrationVoting } from '../../src/sentry/registration-voting.js';
import { createApprovedCodeSet } from '../../src/sentry/agent-verification.js';
import {
  generateAttestation,
  serializeAttestation,
} from '../../src/shared/attestation.js';
import type Database from 'better-sqlite3';

describe('RegistrationVoting', () => {
  let db: Database.Database;
  let registry: LocalRegistryClient;
  let proposals: ProposalManager;
  let voting: VotingSystem;
  let delegations: DelegationTracker;
  let regVoting: RegistrationVoting;

  beforeEach(() => {
    db = createDatabase(':memory:');
    registry = new LocalRegistryClient();
    proposals = new ProposalManager(db);
    delegations = new DelegationTracker(db, 'http://localhost:3000');
    voting = new VotingSystem(db, proposals, delegations);
    const approved = createApprovedCodeSet(); // empty = accept all
    regVoting = new RegistrationVoting(db, registry, proposals, voting, approved);

    // Set up sentry with voting power
    delegations.create({
      delegatorTgId: 'holder-1',
      sentryAddress: 'sentry-1',
      nftTokenIds: [1, 2, 3],
      totalValue: 80000,
      signature: 'sig1',
      expiresAt: '2099-12-31',
    });
  });

  it('creates a registration proposal', async () => {
    const att = generateAttestation('tee-new', 'code-new');

    const result = await regVoting.handleRegistrationRequest({
      teeInstanceId: 'tee-new',
      codeHash: 'code-new',
      attestation: serializeAttestation(att),
      endpoint: 'http://agent:3000',
    });

    expect(result.success).toBe(true);
    expect(result.proposalId).toBeDefined();

    const proposal = proposals.getById(result.proposalId!);
    expect(proposal).toBeDefined();
    expect(proposal!.type).toBe('agent_registration');
    expect(proposal!.threshold_pct).toBe(75);
  });

  it('rejects registration when another agent is active', async () => {
    // Register an agent directly
    await registry.registerAgent({
      teeInstanceId: 'tee-existing',
      codeHash: 'code',
      attestation: '',
      endpoint: '',
    });

    const result = await regVoting.handleRegistrationRequest({
      teeInstanceId: 'tee-new',
      codeHash: 'code-new',
      attestation: '',
      endpoint: '',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('already active');
  });

  it('rejects unapproved code hash', async () => {
    const strictApproved = createApprovedCodeSet(['only-this-hash']);
    const strictRegVoting = new RegistrationVoting(
      db, registry, proposals, voting, strictApproved,
    );

    const result = await strictRegVoting.handleRegistrationRequest({
      teeInstanceId: 'tee-new',
      codeHash: 'wrong-hash',
      attestation: '',
      endpoint: '',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Code hash not approved');
  });

  it('executes passed registration proposal', async () => {
    const att = generateAttestation('tee-new', 'code-new');
    const { proposalId } = await regVoting.handleRegistrationRequest({
      teeInstanceId: 'tee-new',
      codeHash: 'code-new',
      attestation: serializeAttestation(att),
      endpoint: 'http://agent:3000',
    });

    // Sentry votes to approve (80000 / 100000 = 80% > 75%)
    voting.castVote({ proposalId: proposalId!, voterAddress: 'sentry-1', approve: true });
    voting.resolve(proposalId!, 100000);

    expect(proposals.getById(proposalId!)!.status).toBe('passed');

    // Execute registration
    const execResult = await regVoting.executeRegistration(proposalId!);
    expect(execResult.success).toBe(true);

    // Verify agent is now registered
    const agent = await registry.getCurrentAgent();
    expect(agent).not.toBeNull();
    expect(agent!.teeInstanceId).toBe('tee-new');
    expect(agent!.isActive).toBe(true);
  });

  it('rejects execution of non-passed proposal', async () => {
    const att = generateAttestation('tee-new', 'code-new');
    const { proposalId } = await regVoting.handleRegistrationRequest({
      teeInstanceId: 'tee-new',
      codeHash: 'code-new',
      attestation: serializeAttestation(att),
      endpoint: '',
    });

    // Don't vote — proposal is still 'active'
    const result = await regVoting.executeRegistration(proposalId!);
    expect(result.success).toBe(false);
    expect(result.error).toContain('active');
  });

  it('rejects execution of wrong proposal type', async () => {
    const stratId = proposals.create({
      type: 'strategy_change',
      proposer: 's1',
      description: 'not a registration',
    });
    proposals.setStatus(stratId, 'passed');

    const result = await regVoting.executeRegistration(stratId);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Not an agent_registration');
  });
});
