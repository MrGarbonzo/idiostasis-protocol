import type { ProtocolConfig } from '@idiostasis/core';
import type {
  PingEnvelope,
} from '@idiostasis/core';
import type { SnapshotManager } from '@idiostasis/core';
import type { DbSnapshot } from '@idiostasis/core';
import type { LivenessMonitor } from './liveness/monitor.js';
import type { KeyExchangeSession, WrappedKey } from '@idiostasis/core';

// TODO: Replace with Express in a future phase when the guardian
// actually needs to serve HTTP. For now, this module defines the
// endpoint handlers as plain async functions — testable without Express.

export interface AdmissionPayload {
  wrappedVaultKey: WrappedKey;
  dbSnapshot: DbSnapshot;
  primaryX25519PublicKey: Uint8Array;
  primaryEd25519PublicKey: Uint8Array;
}

export type OnAdmissionReceived = (payload: AdmissionPayload) => Promise<void>;

export interface GuardianHttpHandlers {
  handlePing(envelope: PingEnvelope): { ok: boolean; error?: string };
  handleAdmission(payload: AdmissionPayload): Promise<{ accepted: boolean }>;
  handleRecovery(): Promise<{ snapshot: DbSnapshot | null }>;
}

export function createHandlers(
  liveness: LivenessMonitor,
  onAdmission: OnAdmissionReceived,
  snapshotProvider: () => Promise<DbSnapshot | null>,
): GuardianHttpHandlers {
  return {
    handlePing(envelope: PingEnvelope) {
      try {
        liveness.onPingReceived(envelope);
        return { ok: true };
      } catch {
        return { ok: false, error: 'invalid_ping' };
      }
    },

    async handleAdmission(payload: AdmissionPayload) {
      await onAdmission(payload);
      return { accepted: true };
    },

    async handleRecovery() {
      const snapshot = await snapshotProvider();
      return { snapshot };
    },
  };
}
