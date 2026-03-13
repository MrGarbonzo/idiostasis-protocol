/**
 * Health Monitor — periodically query fund manager status and detect anomalies.
 */
import type Database from 'better-sqlite3';
import type { HealthCheck, HealthStatus, FundManagerStatus } from '../shared/types.js';

export interface AnomalyAlert {
  type: 'balance_drop' | 'nft_count_change' | 'pause_detected' | 'unreachable' | 'strategy_change';
  message: string;
  previous: HealthCheck | null;
  current: HealthCheck;
}

export class HealthMonitor {
  private db: Database.Database;
  private fundManagerEndpoint: string;

  constructor(db: Database.Database, fundManagerEndpoint: string) {
    this.db = db;
    this.fundManagerEndpoint = fundManagerEndpoint.replace(/\/$/, '');
  }

  /** Update the fund manager endpoint (e.g., after re-discovery). */
  updateEndpoint(endpoint: string): void {
    this.fundManagerEndpoint = endpoint.replace(/\/$/, '');
  }

  /** Fetch status from fund manager and record a health check. Returns anomalies detected. */
  async check(): Promise<{ check: HealthCheck; anomalies: AnomalyAlert[] }> {
    const previous = this.getLatest();
    let status: FundManagerStatus;

    try {
      const res = await fetch(`${this.fundManagerEndpoint}/status`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      status = (await res.json()) as FundManagerStatus;
    } catch (err) {
      const check = this.record({
        status: 'unreachable',
        details: err instanceof Error ? err.message : String(err),
      });
      const anomalies: AnomalyAlert[] = [];
      // Only emit unreachable anomaly on transition (not on every consecutive failure)
      if (!previous || previous.status !== 'unreachable') {
        anomalies.push({
          type: 'unreachable',
          message: `Fund manager unreachable: ${err instanceof Error ? err.message : err}`,
          previous,
          current: check,
        });
      }
      return { check, anomalies };
    }

    const healthStatus = this.evaluateStatus(status, previous);
    const check = this.record({
      status: healthStatus,
      poolBalance: status.total_pool_balance,
      activeNfts: status.total_nfts_active,
      isPaused: status.is_paused,
      strategy: status.active_strategy,
      details: null,
    });

    const anomalies = this.detectAnomalies(check, previous);
    return { check, anomalies };
  }

  /** Determine health status from fund manager response. */
  private evaluateStatus(status: FundManagerStatus, previous: HealthCheck | null): HealthStatus {
    if (status.is_paused) return 'warning';

    if (previous && previous.pool_balance !== null) {
      const drop = (previous.pool_balance - status.total_pool_balance) / previous.pool_balance;
      if (drop > 0.2) return 'critical';   // >20% balance drop
      if (drop > 0.1) return 'warning';    // >10% balance drop
    }

    return 'healthy';
  }

  /** Detect anomalies by comparing current check to previous. */
  private detectAnomalies(current: HealthCheck, previous: HealthCheck | null): AnomalyAlert[] {
    if (!previous) return [];
    const anomalies: AnomalyAlert[] = [];

    // Balance drop > 10%
    if (
      previous.pool_balance !== null &&
      current.pool_balance !== null &&
      previous.pool_balance > 0
    ) {
      const dropPct =
        ((previous.pool_balance - current.pool_balance) / previous.pool_balance) * 100;
      if (dropPct > 10) {
        anomalies.push({
          type: 'balance_drop',
          message: `Pool balance dropped ${dropPct.toFixed(1)}% (${previous.pool_balance} → ${current.pool_balance})`,
          previous,
          current,
        });
      }
    }

    // NFT count change
    if (
      previous.active_nfts !== null &&
      current.active_nfts !== null &&
      previous.active_nfts !== current.active_nfts
    ) {
      const diff = current.active_nfts - previous.active_nfts;
      anomalies.push({
        type: 'nft_count_change',
        message: `Active NFTs changed by ${diff > 0 ? '+' : ''}${diff} (${previous.active_nfts} → ${current.active_nfts})`,
        previous,
        current,
      });
    }

    // Pause state changed
    if (
      previous.is_paused !== null &&
      current.is_paused !== null &&
      previous.is_paused !== current.is_paused &&
      current.is_paused === 1
    ) {
      anomalies.push({
        type: 'pause_detected',
        message: 'Fund manager has been paused',
        previous,
        current,
      });
    }

    // Strategy changed
    if (
      previous.strategy !== null &&
      current.strategy !== null &&
      previous.strategy !== current.strategy
    ) {
      anomalies.push({
        type: 'strategy_change',
        message: `Strategy changed: ${previous.strategy} → ${current.strategy}`,
        previous,
        current,
      });
    }

    return anomalies;
  }

  /** Record a health check in the database. */
  private record(data: {
    status: HealthStatus;
    poolBalance?: number | null;
    activeNfts?: number | null;
    isPaused?: number | null;
    strategy?: string | null;
    details?: string | null;
  }): HealthCheck {
    const stmt = this.db.prepare(`
      INSERT INTO health_checks (status, pool_balance, active_nfts, is_paused, strategy, details)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      data.status,
      data.poolBalance ?? null,
      data.activeNfts ?? null,
      data.isPaused ?? null,
      data.strategy ?? null,
      data.details ?? null,
    );

    return this.db
      .prepare('SELECT * FROM health_checks WHERE id = ?')
      .get(result.lastInsertRowid) as HealthCheck;
  }

  /** Get the most recent health check. */
  getLatest(): HealthCheck | null {
    return (
      this.db
        .prepare('SELECT * FROM health_checks ORDER BY checked_at DESC LIMIT 1')
        .get() as HealthCheck | null
    ) ?? null;
  }

  /** Get recent health check history. */
  getHistory(limit = 50): HealthCheck[] {
    return this.db
      .prepare('SELECT * FROM health_checks ORDER BY checked_at DESC LIMIT ?')
      .all(limit) as HealthCheck[];
  }

  /** Get count of checks by status in the last N hours. */
  getStatusCounts(hours = 24): Record<HealthStatus, number> {
    const rows = this.db
      .prepare(`
        SELECT status, COUNT(*) as cnt FROM health_checks
        WHERE checked_at >= datetime('now', '-' || ? || ' hours')
        GROUP BY status
      `)
      .all(hours) as { status: HealthStatus; cnt: number }[];

    const counts: Record<HealthStatus, number> = {
      healthy: 0,
      warning: 0,
      critical: 0,
      unreachable: 0,
    };
    for (const row of rows) {
      counts[row.status] = row.cnt;
    }
    return counts;
  }
}
