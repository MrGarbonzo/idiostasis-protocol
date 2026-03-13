/**
 * Agent Registration Flow — ensure only one agent is active at a time.
 *
 * On startup:
 *   1. Get TEE instance ID
 *   2. Check registry → am I registered?
 *   3a. If I'm registered and active → proceed to live mode
 *   3b. If no agent registered → request registration (guardians vote, need 75%)
 *   3c. If different agent active → shut down (prevent duplicate operation)
 *   3d. If registered agent inactive → request takeover
 *
 * Supports both legacy (HMAC) and signed (ed25519 envelope) modes.
 */
import { getTEEInstanceId } from './tee.js';
import type { TEEIdentity } from './tee.js';
import {
  generateAttestation,
  serializeAttestation,
} from './attestation-utils.js';
import type { TEESigner, SignedEnvelope } from './tee-signing.js';
import { createEnvelope } from './tee-signing.js';

/** Registration status returned by the flow. */
export type RegistrationStatus =
  | 'registered'        // I am the active agent
  | 'pending_approval'  // Registration request submitted, waiting for guardian vote
  | 'rejected'          // Guardians rejected registration
  | 'conflict'          // Another agent is active, must shut down
  | 'takeover'          // Taking over from inactive agent
  | 'error';            // Something went wrong

export interface RegistrationResult {
  status: RegistrationStatus;
  teeIdentity: TEEIdentity;
  message: string;
}

export interface RegistryEndpoint {
  /** Guardian endpoint managing the registry. */
  guardianEndpoint: string;
  /** If provided, requests are wrapped in signed envelopes. */
  signer?: TEESigner;
}

/**
 * Run the agent registration flow.
 * Returns the result — caller decides whether to proceed or shut down.
 */
export async function runRegistrationFlow(
  config: RegistryEndpoint,
): Promise<RegistrationResult> {
  const endpoint = config.guardianEndpoint.replace(/\/$/, '');

  // Step 1: Get TEE identity
  let teeIdentity: TEEIdentity;
  try {
    teeIdentity = await getTEEInstanceId();
    console.log(`[Registration] TEE Instance ID: ${teeIdentity.instanceId}`);
    console.log(`[Registration] Code Hash: ${teeIdentity.codeHash}`);
    console.log(`[Registration] TDX mode: ${teeIdentity.isTDX}`);
  } catch (err) {
    return {
      status: 'error',
      teeIdentity: { instanceId: 'unknown', isTDX: false, codeHash: 'unknown' },
      message: `Failed to get TEE identity: ${err instanceof Error ? err.message : err}`,
    };
  }

  // Step 2: Check current registry state
  interface CurrentAgentInfo {
    teeInstanceId: string;
    isActive: boolean;
    lastHeartbeat: string;
  }

  let currentAgent: CurrentAgentInfo | null = null;

  try {
    const res = await fetch(`${endpoint}/api/sentry/agent/current`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      currentAgent = (await res.json()) as CurrentAgentInfo;
    }
    // 404 = no agent registered, which is fine
  } catch {
    // Guardian unreachable — can't register
    return {
      status: 'error',
      teeIdentity,
      message: 'Guardian network unreachable',
    };
  }

  // Step 3a: Am I already registered and active?
  if (currentAgent?.teeInstanceId === teeIdentity.instanceId && currentAgent.isActive) {
    console.log('[Registration] Already registered and active');
    return { status: 'registered', teeIdentity, message: 'Already registered' };
  }

  // Step 3c: Different agent is active — must not double-trade
  if (currentAgent?.isActive && currentAgent.teeInstanceId !== teeIdentity.instanceId) {
    console.log(`[Registration] CONFLICT: Agent ${currentAgent.teeInstanceId} is active`);
    return {
      status: 'conflict',
      teeIdentity,
      message: `Another agent is active: ${currentAgent.teeInstanceId}`,
    };
  }

  // Step 3d: Registered agent is inactive — request takeover
  // Step 3b: No agent registered — request new registration
  const action = currentAgent && !currentAgent.isActive ? 'takeover' : 'new_registration';
  console.log(`[Registration] Requesting ${action}`);

  // Generate attestation for registration request
  const attestation = generateAttestation(teeIdentity.instanceId, teeIdentity.codeHash);
  const attestationStr = serializeAttestation(attestation);

  try {
    const registrationPayload: Record<string, unknown> = {
      teeInstanceId: teeIdentity.instanceId,
      codeHash: teeIdentity.codeHash,
      attestation: attestationStr,
      endpoint: `self`,
    };

    // Include signer keys so the guardian can add us to its trust store
    if (config.signer) {
      registrationPayload.ed25519PubkeyBase64 = config.signer.ed25519PubkeyBase64;
      registrationPayload.x25519PubkeyBase64 = config.signer.x25519PubkeyBase64;
      registrationPayload.x25519Signature = config.signer.x25519Signature;
    }

    // If signer is available, wrap in signed envelope
    let body: string;
    if (config.signer) {
      const envelope = await createEnvelope(
        teeIdentity.instanceId,
        'attest.request',
        registrationPayload,
        config.signer,
      );
      body = JSON.stringify(envelope);
    } else {
      body = JSON.stringify(registrationPayload);
    }

    const res = await fetch(`${endpoint}/api/sentry/agent/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    const result = (await res.json()) as { success: boolean; error?: string; proposalId?: string };

    if (result.success) {
      console.log(`[Registration] ${action === 'takeover' ? 'Takeover' : 'Registration'} successful`);
      return {
        status: action === 'takeover' ? 'takeover' : 'registered',
        teeIdentity,
        message: result.proposalId
          ? `Registration proposal created: ${result.proposalId}`
          : 'Registered',
      };
    }

    // Check if it's pending approval
    if (result.error?.includes('pending') || result.proposalId) {
      return {
        status: 'pending_approval',
        teeIdentity,
        message: `Awaiting guardian approval: ${result.proposalId ?? 'pending'}`,
      };
    }

    return {
      status: 'rejected',
      teeIdentity,
      message: result.error ?? 'Registration rejected',
    };
  } catch (err) {
    return {
      status: 'error',
      teeIdentity,
      message: `Registration request failed: ${err instanceof Error ? err.message : err}`,
    };
  }
}
