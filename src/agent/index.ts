import { createServer } from 'node:http';
import { initContext } from './context.js';
import { startCronJobs } from './cron.js';
import { createTEESigner } from './tee-signing.js';
import { getTEEInstanceId } from './tee.js';
import { runRegistrationFlow } from './registration.js';
import { VaultClient } from './vault-client.js';
import { createHeartbeatManager } from './heartbeat.js';
import { verifyGuardianAttestation, verifyQuoteViaPCCS } from './guardian-verifier.js';
import { aesEncrypt } from './tee-signing.js';
import { ERC8004RegistryClient } from '../registry/erc8004-registry-client.js';
import { VaultKeyManager } from '../vault/key-manager.js';
import { handleConfigRequest } from './config-api.js';
import { unsealConfig } from './unseal-config.js';
import { runBackupAgent, registerSelfOnChain } from './backup-coordination.js';
import { generateAttestation, serializeAttestation } from './attestation-utils.js';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

/** Current hostname — set via AGENT_EXTERNAL_HOST env or /api/set-hostname. */
let currentHostname: string | undefined = process.env.AGENT_EXTERNAL_HOST;

async function main() {
  // Unseal boot-agent config before reading env vars
  unsealConfig();

  const agentRole = (process.env.AGENT_ROLE ?? 'backup').toLowerCase();
  console.log(`[idiostasis] Starting agent (role: ${agentRole})...`);

  // ── Backup Agent Mode ───────────────────────────────────────
  // If AGENT_ROLE=backup, enter standby → wait for primary failure → take over
  if (agentRole === 'backup') {
    console.log('[idiostasis] Backup mode — initializing TEE identity...');

    const backupSigner = await createTEESigner();
    const backupTeeIdentity = await getTEEInstanceId();
    console.log(`[idiostasis] Backup TEE: ${backupTeeIdentity.instanceId} (TDX: ${backupTeeIdentity.isTDX})`);

    // Start minimal HTTP server for guardian-initiated failover + health checks.
    const statusPort = Number(process.env.STATUS_PORT) || 8080;
    const backupExternalHost = process.env.AGENT_EXTERNAL_HOST;
    let backupOwnEndpoint = backupExternalHost
      ? `http://${backupExternalHost}:${statusPort}`
      : `http://localhost:${statusPort}`;

    const backupServer = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ role: 'backup', state: 'standby', teeId: backupTeeIdentity.instanceId }));
      } else if (req.method === 'POST' && req.url === '/api/backup/ready') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const { action } = JSON.parse(body) as { action?: string };
            if (action !== 'takeover') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'unknown action' }));
              return;
            }

            const attestation = generateAttestation(backupTeeIdentity.instanceId, backupTeeIdentity.codeHash);
            console.log('[idiostasis] Guardian requested takeover — sending registration details');

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              teeInstanceId: backupTeeIdentity.instanceId,
              codeHash: backupTeeIdentity.codeHash,
              attestation: serializeAttestation(attestation),
              endpoint: backupOwnEndpoint,
              ed25519PubkeyBase64: backupSigner.ed25519PubkeyBase64,
              x25519PubkeyBase64: backupSigner.x25519PubkeyBase64,
              x25519Signature: backupSigner.x25519Signature,
            }));
          } catch {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal error' }));
          }
        });
      } else if (req.method === 'GET' && req.url === '/api/backup/ready') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ready: true }));
      } else if (req.method === 'POST' && req.url === '/api/set-hostname') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const { hostname } = JSON.parse(body) as { hostname: string };
            if (!hostname) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'missing hostname' }));
              return;
            }
            backupOwnEndpoint = `http://${hostname}:${statusPort}`;
            console.log(`[idiostasis] Backup hostname set by boot-agent: ${hostname} → ${backupOwnEndpoint}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, endpoint: backupOwnEndpoint }));
          } catch {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal error' }));
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    backupServer.listen(statusPort, () => {
      console.log(`[idiostasis] Backup status server listening on port ${statusPort}`);
    });

    // Discover primary agent endpoint from ERC-8004 registry (required for backup)
    let primaryAgentEndpoint: string | undefined;
    const registryContractForBackup = process.env.REGISTRY_CONTRACT_ADDRESS;
    if (registryContractForBackup) {
      try {
        const evmRpcUrl = requireEnv('EVM_RPC_URL');
        const backupAccount = backupSigner as any;
        const regClient = new ERC8004RegistryClient(
          evmRpcUrl,
          backupAccount,
          registryContractForBackup as `0x${string}`,
        );
        const agents = await regClient.getAgents();
        const activeAgent = agents.find((a: any) => a.isActive);
        if (activeAgent) {
          primaryAgentEndpoint = activeAgent.endpoint;
          console.log(`[idiostasis] Backup discovered primary at: ${primaryAgentEndpoint}`);
        }
      } catch (err) {
        console.warn(`[idiostasis] Backup primary discovery failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (!primaryAgentEndpoint) {
      throw new Error('Backup agent requires a primary agent — set REGISTRY_CONTRACT_ADDRESS and ensure primary is registered on-chain');
    }

    // Guardian endpoint is optional — guardian contacts us via POST /api/backup/ready when needed
    let guardianEndpoint: string | undefined;
    const bootstrapEndpoints = (process.env.BOOTSTRAP_GUARDIANS ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (bootstrapEndpoints.length > 0) {
      guardianEndpoint = bootstrapEndpoints[0];
      console.log(`[idiostasis] Backup has bootstrap guardian: ${guardianEndpoint}`);
    } else if (registryContractForBackup) {
      try {
        const evmRpcUrl = requireEnv('EVM_RPC_URL');
        const backupAccount = backupSigner as any;
        const regClient = new ERC8004RegistryClient(
          evmRpcUrl,
          backupAccount,
          registryContractForBackup as `0x${string}`,
        );
        const guardians = await regClient.getGuardians();
        const active = guardians.find(g => g.isActive);
        if (active) {
          guardianEndpoint = active.endpoint;
          console.log(`[idiostasis] Backup has registry guardian: ${guardianEndpoint}`);
        }
      } catch (err) {
        console.warn(`[idiostasis] Backup guardian lookup failed (non-fatal): ${err instanceof Error ? err.message : err}`);
      }
    }
    if (!guardianEndpoint) {
      console.log('[idiostasis] No guardian endpoint — guardian will contact us via /api/backup/ready');
    }

    const dbDir = process.env.IDIOSTASIS_DB_DIR ?? '/data';
    console.log('[idiostasis] Entering standby mode — waiting for primary failure...');

    const takeoverResult = await runBackupAgent({
      guardianEndpoint,
      dbDir,
      ownEndpoint: backupOwnEndpoint,
      ed25519PubkeyBase64: backupSigner.ed25519PubkeyBase64,
      primaryAgentEndpoint,
    });
    if (!takeoverResult) {
      throw new Error('Backup takeover returned null — cannot continue');
    }

    console.log(`[idiostasis] Takeover successful! DB recovered at: ${takeoverResult.dbPath}`);

    // Close the minimal backup server — the full server will start below
    backupServer.close();

    // Set the recovered DB path for the rest of startup
    if (takeoverResult.dbPath) {
      process.env.IDIOSTASIS_DB_PATH = takeoverResult.dbPath;
    }

    console.log('[idiostasis] Transitioning to primary mode...');
  }

  // ── Initialize service context ──────────────────────────────
  const ctx = initContext({
    dbPath: process.env.IDIOSTASIS_DB_PATH ?? '/data/idiostasis.db',
    evmRpcUrl: requireEnv('EVM_RPC_URL'),
  });

  console.log('[idiostasis] Context initialized, wallet addresses:', ctx.wallet.addresses);

  // ── TEE Signing + Identity + VaultClient ───────────────────
  let signer: Awaited<ReturnType<typeof createTEESigner>> | undefined;
  let teeIdentity: Awaited<ReturnType<typeof getTEEInstanceId>> | undefined;
  let vaultClient: VaultClient | undefined;

  try {
    signer = await createTEESigner();
    console.log(`[idiostasis] TEE signer initialized (production: ${signer.isProduction})`);

    teeIdentity = await getTEEInstanceId();
    console.log(`[idiostasis] TEE identity: ${teeIdentity.instanceId} (TDX: ${teeIdentity.isTDX})`);

    vaultClient = new VaultClient({
      nodeId: teeIdentity.instanceId,
      signer,
    });

    // Vault key: use VaultKeyManager for persistent key across restarts
    const keyManager = new VaultKeyManager(teeIdentity.instanceId, teeIdentity.codeHash);
    const vaultKey = keyManager.initialize(process.env.VAULT_KEY);
    vaultClient.setVaultKey(vaultKey);
  } catch (err) {
    console.warn(`[idiostasis] TEE init failed (non-fatal): ${err instanceof Error ? err.message : err}`);
  }

  // ── Start HTTP status server (for guardian health checks) ─────
  const statusPort = Number(process.env.STATUS_PORT) || 8080;
  const dbPath = process.env.IDIOSTASIS_DB_PATH ?? '/data/idiostasis.db';
  const server = createServer((req, res) => {
    // Try governance config routes first
    if (handleConfigRequest(req, res, { db: ctx.db })) return;

    if (req.method === 'GET' && req.url === '/status') {
      try {
        const state = ctx.db.getNodeState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          is_paused: state.is_paused,
          node_id: teeIdentity?.instanceId ?? 'unknown',
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      }
    } else if (req.method === 'POST' && req.url === '/api/backup/register') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const { id, endpoint } = JSON.parse(body) as { id: string; endpoint: string };
          if (!id || !endpoint) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'missing id or endpoint' }));
            return;
          }
          const position = ctx.db.registerBackupAgent(id, endpoint);
          console.log(`[idiostasis] Backup agent registered: ${id.substring(0, 16)}... at position ${position}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, position }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal error' }));
        }
      });
    } else if (req.method === 'POST' && req.url === '/api/backup/heartbeat') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const { id, endpoint } = JSON.parse(body) as { id: string; endpoint?: string };
          if (!id) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'missing id' }));
            return;
          }
          const updated = ctx.db.backupAgentHeartbeat(id, endpoint);
          if (!updated) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'backup agent not found — register first' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal error' }));
        }
      });
    } else if (req.method === 'GET' && req.url === '/api/backup/list') {
      try {
        const backups = ctx.db.getBackupAgents();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ backups }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      }
    } else if (req.method === 'POST' && req.url === '/api/set-hostname') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const { hostname } = JSON.parse(body) as { hostname: string };
          if (!hostname) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'missing hostname' }));
            return;
          }
          currentHostname = hostname;
          console.log(`[idiostasis] Hostname set by boot-agent: ${hostname}`);
          if (registryClient && teeIdentity) {
            const endpoint = `http://${hostname}:${statusPort}`;
            await registryClient.registerSelf({
              entityType: 'agent',
              endpoint,
              teeInstanceId: teeIdentity.instanceId,
              codeHash: teeIdentity.codeHash,
              attestationHash: '',
              ed25519Pubkey: signer?.ed25519PubkeyBase64 ?? '',
              isActive: true,
            });
            registeredOnChain.value = true;
            console.log(`[idiostasis] Re-registered on-chain with endpoint: ${endpoint}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, endpoint }));
          } else {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'registry client not initialized' }));
          }
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'internal error' }));
        }
      });
    } else if (req.method === 'GET' && req.url === '/api/fund-address') {
      try {
        const evmAddress = ctx.wallet.addresses.evm;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ evmAddress }));
      } catch {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'wallet not initialized' }));
      }
    } else if (req.method === 'POST' && req.url === '/api/attestation') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          if (!signer || !vaultClient) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'TEE signer or vault not initialized' }));
            return;
          }

          const vaultKey = vaultClient.getVaultKey();
          if (!vaultKey) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Vault key not available' }));
            return;
          }

          const {
            ed25519Pubkey: reqEd25519Pubkey,
            attestationQuote,
            x25519Pubkey,
            x25519Signature,
            senderId,
          } = JSON.parse(body) as {
            ed25519Pubkey: string;
            attestationQuote: string;
            x25519Pubkey: string;
            x25519Signature: string;
            senderId: string;
          };

          if (!attestationQuote || !x25519Pubkey || !reqEd25519Pubkey) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Missing required fields' }));
            return;
          }

          // Verify attestation quote via PCCS
          const pccsResult = await verifyQuoteViaPCCS(attestationQuote);
          if (!pccsResult.valid) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `Attestation failed: ${pccsResult.error}` }));
            return;
          }

          // Check RTMR3 against approved measurements
          if (approvedMeasurements.size > 0) {
            if (!pccsResult.containerMeasurement || !approvedMeasurements.has(pccsResult.containerMeasurement)) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                success: false,
                error: `Container measurement not approved: ${pccsResult.containerMeasurement ?? 'missing'}`,
              }));
              return;
            }
          } else {
            if (!pccsResult.containerMeasurement) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                success: false,
                error: 'First guardian must provide a container measurement to auto-enroll',
              }));
              return;
            }
            approvedMeasurements.add(pccsResult.containerMeasurement);
            console.log(`[idiostasis] First-guardian auto-enrollment: locked to measurement ${pccsResult.containerMeasurement}`);
          }

          // Verify X25519 pubkey signature (proves same TEE owns both keys)
          const x25519SigValid = signer.verify(
            Buffer.from(x25519Pubkey),
            x25519Signature,
            reqEd25519Pubkey,
          );
          if (!x25519SigValid) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'X25519 pubkey signature invalid' }));
            return;
          }

          // Wrap vault key using ECDH shared secret + AES-256-GCM
          const sharedSecret = signer.ecdh(x25519Pubkey);
          const encrypted = aesEncrypt(sharedSecret, vaultKey);
          const signPayload = `${encrypted.ciphertext}|${encrypted.iv}|${encrypted.authTag}`;
          const signature = await signer.sign(signPayload);

          console.log(`[idiostasis] Vault key shared with ${senderId ?? 'unknown'} via attestation`);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            wrappedVaultKey: {
              encryptedVaultKey: encrypted.ciphertext,
              iv: encrypted.iv,
              authTag: encrypted.authTag,
              senderX25519Pubkey: signer.x25519PubkeyBase64,
              signature,
            },
            senderEd25519Pubkey: signer.ed25519PubkeyBase64,
          }));
        } catch (err) {
          console.error('[idiostasis] Attestation endpoint error:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Internal error' }));
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(statusPort, () => {
    console.log(`[idiostasis] Status server listening on port ${statusPort}`);
  });

  // ── Discover guardians from ERC-8004 registry ─────────────────
  const registryContractAddr = process.env.REGISTRY_CONTRACT_ADDRESS;
  let registryClient: ERC8004RegistryClient | undefined;
  const registeredOnChain: { value: boolean } = { value: false };

  if (registryContractAddr) {
    const evmRpcUrl = requireEnv('EVM_RPC_URL');
    const agentAccount = ctx.wallet.getEvmAccount();

    registryClient = new ERC8004RegistryClient(
      evmRpcUrl,
      agentAccount,
      registryContractAddr as `0x${string}`,
    );

    // Register self in registry — only if hostname is known
    if (teeIdentity && currentHostname) {
      try {
        await registryClient.registerSelf({
          entityType: 'agent',
          endpoint: `http://${currentHostname}:${statusPort}`,
          teeInstanceId: teeIdentity.instanceId,
          codeHash: teeIdentity.codeHash,
          attestationHash: '',
          ed25519Pubkey: signer?.ed25519PubkeyBase64 ?? '',
          isActive: true,
        });
        registeredOnChain.value = true;
        console.log('[idiostasis] Registered in ERC-8004 discovery registry');
      } catch (err) {
        console.warn(`[idiostasis] Registry self-registration failed (will retry via cron): ${err instanceof Error ? err.message : err}`);
      }
    } else if (teeIdentity && !currentHostname) {
      console.log('[idiostasis] Deferring on-chain registration — waiting for /api/set-hostname');
    }

    // If we just completed a backup takeover, register on-chain with our endpoint
    if (agentRole === 'backup' && teeIdentity && registryClient) {
      const backupEndpoint = currentHostname
        ? `http://${currentHostname}:${statusPort}`
        : undefined;
      if (backupEndpoint) {
        const regResult = await registerSelfOnChain({
          registryClient,
          teeIdentity,
          endpoint: backupEndpoint,
          ed25519Pubkey: signer?.ed25519PubkeyBase64 ?? '',
        });
        if (regResult.success) {
          registeredOnChain.value = true;
          console.log(`[idiostasis] Backup registered on-chain at ${backupEndpoint}`);
        }
      } else {
        console.log('[idiostasis] Backup deferring on-chain registration — no hostname yet');
      }
    }

    // Discover guardians from registry
    try {
      const guardianEntries = await registryClient.getGuardians();
      for (const entry of guardianEntries) {
        if (!entry.isActive) continue;
        const now = Date.now();
        ctx.discoveredGuardians.set(entry.teeInstanceId, {
          address: entry.teeInstanceId,
          endpoint: entry.endpoint,
          isSentry: true,
          discoveredAt: now,
          lastSeen: now,
          verified: false,
        });
        console.log(`[idiostasis] Discovered guardian: ${entry.teeInstanceId} at ${entry.endpoint}`);
      }
    } catch (err) {
      console.warn(`[idiostasis] Registry discovery failed: ${err instanceof Error ? err.message : err}`);
    }

    console.log(`[idiostasis] Discovered ${ctx.discoveredGuardians.size} guardian(s) from ERC-8004 registry`);
  } else {
    console.log('[idiostasis] REGISTRY_CONTRACT_ADDRESS not set — on-chain discovery disabled');
  }

  // ── Fallback: BOOTSTRAP_GUARDIANS direct HTTP ping ──────────
  const bootstrapEndpoints = (process.env.BOOTSTRAP_GUARDIANS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (bootstrapEndpoints.length > 0 && ctx.discoveredGuardians.size === 0) {
    for (const endpoint of bootstrapEndpoints) {
      try {
        const res = await fetch(`${endpoint.replace(/\/$/, '')}/ping`, { signal: AbortSignal.timeout(5_000) });
        const data = await res.json() as { guardian?: string; status?: string };
        if (data.status === 'ok' && data.guardian) {
          const address = data.guardian;
          if (!ctx.discoveredGuardians.has(address)) {
            const now = Date.now();
            ctx.discoveredGuardians.set(address, {
              address,
              endpoint: endpoint.replace(/\/$/, ''),
              isSentry: true,
              discoveredAt: now,
              lastSeen: now,
              verified: false,
            });
            console.log(`[idiostasis] Bootstrap discovered: ${address} at ${endpoint}`);
          }
        }
      } catch (err) {
        console.warn(`[idiostasis] Bootstrap ping failed for ${endpoint}: ${err instanceof Error ? err.message : err}`);
      }
    }
    console.log(`[idiostasis] Bootstrap discovered ${ctx.discoveredGuardians.size} guardian(s)`);
  }

  // ── Verify guardian attestations ────────────────────────────
  const approvedMeasurements = new Set(
    (process.env.APPROVED_MEASUREMENTS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  );

  for (const [address, guardian] of ctx.discoveredGuardians) {
    console.log(`[idiostasis] Verifying attestation for ${address} at ${guardian.endpoint}...`);
    const result = await verifyGuardianAttestation(guardian.endpoint, approvedMeasurements);

    if (result.valid) {
      guardian.verified = true;
      console.log(`[idiostasis] Guardian ${address} attestation verified (measurement: ${result.codeMeasurement ?? 'n/a'})`);
    } else {
      console.warn(`[idiostasis] Guardian ${address} attestation FAILED: ${result.error}`);
      ctx.discoveredGuardians.delete(address);
    }
  }

  console.log(`[idiostasis] ${ctx.discoveredGuardians.size} verified guardian(s)`);

  // ── Registration + Heartbeat ────────────────────────────────
  if (signer && teeIdentity) {
    for (const [address, guardian] of ctx.discoveredGuardians) {
      try {
        const regResult = await runRegistrationFlow({
          guardianEndpoint: guardian.endpoint,
          signer,
        });
        console.log(`[idiostasis] Registration with ${address}: ${regResult.status} — ${regResult.message}`);

        if (regResult.status === 'conflict') {
          console.error(`[idiostasis] Agent conflict with ${address} — another agent is active`);
          continue;
        }

        const heartbeat = createHeartbeatManager({
          guardianEndpoint: guardian.endpoint,
          teeIdentity: regResult.teeIdentity,
          signer,
          onDeactivation: (reason) => {
            console.error(`[idiostasis] Deactivated by ${address}: ${reason}`);
          },
          onHeartbeat: (success, failures) => {
            if (!success) {
              console.warn(`[idiostasis] Heartbeat to ${address} failed (${failures} consecutive)`);
            }
          },
        });
        heartbeat.start();
        console.log(`[idiostasis] Heartbeat started for ${address}`);
      } catch (err) {
        console.warn(`[idiostasis] Guardian ${address} setup failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // ── Start cron jobs ─────────────────────────────────────────
  const agentEndpoint = currentHostname ? `http://${currentHostname}:${statusPort}` : undefined;
  startCronJobs(ctx, {
    vaultClient,
    discoveredGuardians: ctx.discoveredGuardians,
    dbPath,
    registryClient,
    agentEndpoint,
    teeInstanceId: teeIdentity?.instanceId,
    ed25519Pubkey: signer?.ed25519PubkeyBase64,
    codeHash: teeIdentity?.codeHash,
    registeredOnChain,
  });

  // ── Log startup complete ───────────────────────────────────
  const registryLine = registryContractAddr
    ? `Registry: ${registryContractAddr}`
    : 'Registry: not configured';
  const guardianCount = ctx.discoveredGuardians.size;
  const regStatus = registeredOnChain.value ? 'registered' : 'pending (will retry)';
  const evmAddress = ctx.wallet.addresses.evm;

  console.log(
    `[idiostasis] Node is online.\n` +
    `  EVM: ${evmAddress}\n` +
    `  ${registryLine}\n` +
    `  On-chain: ${regStatus}\n` +
    `  Guardians: ${guardianCount} verified\n` +
    `  Endpoint: ${agentEndpoint ?? 'pending (waiting for /api/set-hostname)'}`
  );
}

main().catch((err) => {
  console.error('[idiostasis] Fatal error:', err);
  process.exit(1);
});
