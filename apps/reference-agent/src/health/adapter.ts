import type { HealthCheckAdapter, HealthCheckResult } from '@idiostasis/core';
import type { MoltbookStateAdapter } from '../state/adapter.js';
import type { MoltbookClient } from '../moltbook/client.js';

export class MoltbookHealthAdapter implements HealthCheckAdapter {
  constructor(
    private readonly stateAdapter: MoltbookStateAdapter,
    private readonly moltbookClient: MoltbookClient,
  ) {}

  async check(): Promise<HealthCheckResult> {
    // 1. State integrity (critical)
    const stateOk = await this.stateAdapter.verify();
    if (!stateOk) {
      return { healthy: false, severity: 'critical', reason: 'state integrity check failed' };
    }

    // 2. Session expired (warning)
    const state = this.stateAdapter.getState();
    const expiresAt = state.credentials.sessionExpiresAt;
    if (expiresAt) {
      const expiryTime = new Date(expiresAt).getTime();
      const now = Date.now();

      if (now >= expiryTime) {
        return { healthy: false, severity: 'warning', reason: 'session expired' };
      }

      // 3. Session expiring soon — within 1 hour (warning)
      const oneHourMs = 60 * 60 * 1000;
      if (expiryTime - now < oneHourMs) {
        return { healthy: true, severity: 'warning', reason: 'session expiring soon' };
      }
    }

    // 4. API ping (warning on failure)
    try {
      const pingResult = await Promise.race([
        this.moltbookClient.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('ping timeout')), 5000),
        ),
      ]);
      if (!pingResult.ok) {
        return { healthy: false, severity: 'warning', reason: 'API ping returned not ok' };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      return { healthy: false, severity: 'warning', reason: `API ping failed: ${message}` };
    }

    return { healthy: true, severity: 'ok' };
  }
}
