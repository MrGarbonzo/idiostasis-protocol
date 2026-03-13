/**
 * Agent Config API — HTTP handler for governance-approved config changes.
 *
 * Sentries push approved config changes here after a proposal passes.
 * Each route persists the change (to governance_config or native tables)
 * so it survives agent restarts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseLedger } from '../database/ledger.js';

export interface ConfigApiDeps {
  db: DatabaseLedger;
}

interface ConfigRequest {
  proposalId: string;
  type: string;
  action: string;
  payload: Record<string, unknown>;
}

/**
 * Try to handle the request as a config API route.
 * Returns true if the route was handled, false otherwise.
 */
export function handleConfigRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConfigApiDeps,
): boolean {
  if (req.method !== 'POST') return false;
  const url = req.url ?? '';
  if (!url.startsWith('/api/config/')) return false;

  // Parse the route segment after /api/config/
  const route = url.slice('/api/config/'.length).split('?')[0];
  const knownRoutes = ['rpc', 'node-config', 'pause', 'tee-measurements', 'code-update'];
  if (!knownRoutes.includes(route)) return false;

  // Read body and dispatch
  let body = '';
  req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
  req.on('end', () => {
    try {
      const data = JSON.parse(body) as ConfigRequest;
      if (!data.proposalId || !data.type) {
        sendJson(res, 400, { error: 'Missing proposalId or type' });
        return;
      }
      const result = dispatchConfigRoute(route, data, deps);
      sendJson(res, result.status, result.body);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  return true;
}

function dispatchConfigRoute(
  route: string,
  data: ConfigRequest,
  deps: ConfigApiDeps,
): { status: number; body: Record<string, unknown> } {
  switch (route) {
    case 'rpc':
      return handleRpc(data, deps);
    case 'node-config':
      return handleNodeConfig(data, deps);
    case 'pause':
      return handlePause(data, deps);
    case 'tee-measurements':
      return handleTEEMeasurements(data, deps);
    case 'code-update':
      return handleCodeUpdate(data);
    default:
      return { status: 404, body: { error: 'Unknown config route' } };
  }
}

// ── Route handlers ──────────────────────────────────────────

function handleRpc(
  data: ConfigRequest,
  deps: ConfigApiDeps,
): { status: number; body: Record<string, unknown> } {
  const { action, payload } = data;
  const chain = String(payload.chain ?? 'evm');
  const url = String(payload.url ?? '');

  if (!url) {
    return { status: 400, body: { error: 'Missing payload.url' } };
  }

  // Store RPC endpoints as JSON array in governance_config
  const existing = deps.db.getConfigValue('rpc_endpoints');
  const endpoints: Array<{ chain: string; url: string }> = existing ? JSON.parse(existing) : [];

  if (action === 'add') {
    if (!endpoints.some((e) => e.url === url)) {
      endpoints.push({ chain, url });
    }
  } else if (action === 'remove') {
    const idx = endpoints.findIndex((e) => e.url === url);
    if (idx >= 0) endpoints.splice(idx, 1);
  } else {
    return { status: 400, body: { error: `Unknown action: ${action}` } };
  }

  deps.db.setConfigValue('rpc_endpoints', JSON.stringify(endpoints));
  return { status: 200, body: { ok: true, proposalId: data.proposalId, rpcEndpoints: endpoints } };
}

function handleNodeConfig(
  data: ConfigRequest,
  deps: ConfigApiDeps,
): { status: number; body: Record<string, unknown> } {
  const parameters = data.payload;
  if (!parameters || Object.keys(parameters).length === 0) {
    return { status: 400, body: { error: 'Missing payload (node config parameters)' } };
  }

  deps.db.setNodeConfig(parameters as Record<string, unknown>);
  return { status: 200, body: { ok: true, proposalId: data.proposalId, parameters } };
}

function handlePause(
  data: ConfigRequest,
  deps: ConfigApiDeps,
): { status: number; body: Record<string, unknown> } {
  if (data.action === 'pause') {
    deps.db.pauseNode();
    return { status: 200, body: { ok: true, proposalId: data.proposalId, paused: true } };
  }
  if (data.action === 'unpause') {
    deps.db.unpauseNode();
    return { status: 200, body: { ok: true, proposalId: data.proposalId, paused: false } };
  }
  return { status: 400, body: { error: `Unknown action: ${data.action}` } };
}

function handleTEEMeasurements(
  data: ConfigRequest,
  deps: ConfigApiDeps,
): { status: number; body: Record<string, unknown> } {
  const measurement = String(data.payload.measurement ?? '');
  if (!measurement) {
    return { status: 400, body: { error: 'Missing payload.measurement' } };
  }

  const existing = deps.db.getConfigValue('tee_measurements');
  const measurements: string[] = existing ? JSON.parse(existing) : [];

  if (data.action === 'approve') {
    if (!measurements.includes(measurement)) {
      measurements.push(measurement);
    }
  } else if (data.action === 'revoke') {
    const idx = measurements.indexOf(measurement);
    if (idx >= 0) measurements.splice(idx, 1);
  } else {
    return { status: 400, body: { error: `Unknown action: ${data.action}` } };
  }

  deps.db.setConfigValue('tee_measurements', JSON.stringify(measurements));
  return { status: 200, body: { ok: true, proposalId: data.proposalId, measurements } };
}

function handleCodeUpdate(
  data: ConfigRequest,
): { status: number; body: Record<string, unknown> } {
  // Acknowledge only — actual update requires container restart
  console.log(`[config-api] Code update acknowledged: proposal=${data.proposalId}, version=${data.payload.version ?? 'unknown'}`);
  return {
    status: 200,
    body: {
      ok: true,
      proposalId: data.proposalId,
      acknowledged: true,
      message: 'Code update acknowledged. Container restart required for actual update.',
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
