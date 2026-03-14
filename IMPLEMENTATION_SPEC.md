# Idiostasis Protocol — Implementation Spec

**Status:** Pre-build reference document  
**Repo:** `idiostasis-protocol` (public GitHub, new — not forked from attested_capital)  
**Date:** 2026-03-13  
**Companion docs:** KNOWLEDGE_EXTRACTION.md (attested_capital), whitepaper  

This document is the authoritative build reference for Claude Code.  
The whitepaper defines what and why. This document defines how, exactly.  
Do not make architectural decisions not covered here — flag them instead.

---

## 1. Repo Structure

```
idiostasis-protocol/
  packages/
    core/                   # Vault key, attestation, heartbeat, succession, DB
    guardian/               # Guardian node — protocol-level only
    boot/                   # Boot agent — protocol-level only
    erc8004-client/         # Base / ERC-8004 registry interaction
    x402-client/            # x402 HTTP payment protocol
  apps/
    reference-agent/        # Moltbook reference implementation
  docs/
    whitepaper.md           # Whitepaper (source of truth for protocol spec)
  .github/
    workflows/              # CI: build + test changed packages only
  docker/
    agent.dockerfile
    guardian.dockerfile
    boot.dockerfile
  .dockerignore             # Required — every image context
  turbo.json                # Turborepo config
  package.json              # Workspace root
  tsconfig.base.json
  README.md
```

### Package boundaries — hard rules

`packages/` contains **zero application-specific logic**. No Moltbook API references.  
No trading logic. No fund logic. No Panthers references anywhere in this repo.

`apps/reference-agent/` imports from `packages/` and implements adapter interfaces.  
It contains only what a Moltbook agent needs: credential state, session management,
Moltbook API client, and implementations of `AgentStateAdapter` and `HealthCheckAdapter`.

`packages/erc8004-client/` and `packages/x402-client/` are standalone packages,
importable independently of the rest of the protocol.

---

## 2. Resolved Protocol Decisions

### Decision 1 — Vault Key Sealing: Stable Identity Derivation

**Problem:** Deriving sealing key from `codeHash` makes sealed data unrecoverable  
after any code update. Previous implementation used  
`SHA256("vault-seal|{teeInstanceId}|{codeHash}")`.

**Decision:** Derive sealing key from `teeInstanceId` only:  
`SHA256("idiostasis-vault-seal-v1|{teeInstanceId}")`

`teeInstanceId` is stable across code updates for a given VM instance.  
Code updates change `RTMR3` (admission gate) but not the instance identity.  
The sealing key stays constant for the life of a VM instance.

**Migration path on succession:** Successor generates a new vault key inside its  
own TEE, re-encrypts the database with the new key, distributes new key to all  
guardians via standard admission. Old key is never reused. See Decision 6.

**What is never an input to sealing key derivation:** codeHash, RTMR3,  
any value that changes on upgrade.

---

### Decision 2 — Dual RTMR3 Model: Agent and Guardian Are Separate Trust Domains

**Problem:** Agent and guardian run different codebases with different RTMR3 values.  
Neither role should be able to influence the other's approved measurements.

**Decision:**
- The **primary agent** reads its own RTMR3 at boot from `/dev/attestation/rtmr3`.  
  This value is the `AGENT_APPROVED_RTMR3`. It is set once at initialization,  
  stored in the protocol DB `config` table, and never modifiable after that.
- The **guardian** has its own `GUARDIAN_APPROVED_RTMR3` env var, set at deploy time.  
  Guardians verify that connecting backup agents match `AGENT_APPROVED_RTMR3`  
  (read from the DB snapshot they hold). Guardians verify other guardians against  
  `GUARDIAN_APPROVED_RTMR3`.
- The primary agent's admission logic: connecting node claims a role. If role=guardian,  
  verify against `GUARDIAN_APPROVED_RTMR3` env var. If role=backup, verify against  
  own RTMR3 (same codebase). Agent never reads `GUARDIAN_APPROVED_RTMR3` from  
  outside — it is a guardian-side concern.
- **First-boot trust root:** The primary sets `AGENT_APPROVED_RTMR3` from its own  
  `/dev/attestation/rtmr3` at initialization. No external node can influence this value.  
  This is a hard requirement. Log the locked value explicitly at startup.

---

### Decision 3 — Succession Testing is a Build Gate

**Problem:** End-to-end succession has never completed in prior implementation.

**Decision:** The repository ships with a local succession simulation harness in  
`packages/core/test/succession-e2e/`. This harness:
- Spins up primary agent, 2 guardians, and 2 backup agents as local processes
- Uses dev-mode attestation (SHA256 hash fallback, no real TEE required)
- Kills the primary and verifies succession completes within configurable timeout
- Verifies ERC-8004 registry update fires on the new primary
- Verifies vault key is inaccessible to processes that did not complete attestation

**No protocol release without a passing succession e2e test.** CI enforces this.

---

### Decision 4 — Attestation Provider: SecretLabs PCCS with Swappable Interface

**Problem:** Intel DCAP libraries are C `.so` files — not Node.js native.  
Intel's own DCAP QuoteVerificationService repo was archived October 2025.  
Running it from TypeScript requires FFI bindings, significant extra work for v1.

**Decision:** SecretLabs PCCS (`https://pccs.scrtlabs.com/dcap-tools/quote-parse`)  
is the v1 attestation provider. It is accessed only through the `AttestationProvider`  
interface (see Section 4). Swapping to Intel DCAP or any other provider requires  
only a new implementation of that interface — zero protocol code changes.

**Fallback chain for PCCS:**
1. Primary: `https://pccs.scrtlabs.com/dcap-tools/quote-parse`
2. Configured alternates: `PCCS_ENDPOINTS` env var, comma-separated list
3. Each endpoint tried in order on failure. Hard failure only if all exhausted.

**cpu.html extraction — always multi-strategy:**  
Never trust a single HTML parsing strategy. Always implement in order:
1. `<pre>` tag content
2. `<textarea>` tag content
3. Longest hex string ≥ 128 chars
4. Longest base64 string ≥ 128 chars  

Log which strategy succeeded. This is non-negotiable — format has varied in production.

**TLS for port 29343:** Always use per-request `https.Agent({ rejectUnauthorized: false })`.  
Never set `NODE_TLS_REJECT_UNAUTHORIZED` as a global process variable.  
This is a known race condition in the prior implementation.

**PCCS response field names:** Always check both `rtmr_3` and `rtmr3`.  
Both have appeared. Check both, always.

---

### Decision 5 — Re-attestation: Periodic Full + Per-Exchange Signature

**Problem:** Current trust store is write-only. Once trusted, always trusted.

**Decision:** Two-tier verification:

**Tier 1 — Lightweight, every DB push:**  
Every DB snapshot pushed from primary to guardian is signed with the primary's  
TEE Ed25519 key. Guardian verifies signature against the previously-attested  
public key. Adds ~1ms. Catches key rotation or impersonation between attestations.

**Tier 2 — Full re-attestation, configurable interval:**  
Default: every 6 hours (`RE_ATTESTATION_INTERVAL_HOURS`, default `6`).  
Primary initiates fresh attestation handshake with each guardian.  
Guardian initiates fresh attestation handshake with each known backup agent.  
Full PCCS quote verification. Result updates `last_attested_at` in DB.  
Failure → log warning, mark peer as `pending_re_attestation`, retry next cycle.  
Two consecutive failures → remove from trusted peers, require full re-admission.

---

### Decision 6 — Vault Key Rotation on Succession (v1 Core, not future work)

**Problem:** Whitepaper lists this as Section 7 future work.  
Building fresh — this must be v1 to avoid split-brain scenarios.

**Decision:** On succession completion:
1. Successor generates a **new** vault key inside its own TEE enclave.
2. Decrypts inherited database using the old vault key (received from guardian).
3. Re-encrypts database with new vault key.
4. Distributes new vault key to all registered guardians via standard admission handshake.
5. Old vault key is zeroed in memory.
6. Updates ERC-8004 registry. This is the finalization signal.

Any guardian that completes handshake with new primary receives new vault key.  
Any guardian still holding old key cannot decrypt future DB snapshots.  
Old primary, if it recovers, holds stale key and cannot re-enter without fresh admission.

---

### Decision 7 — Tie-Breaking in Succession (Fully Deterministic)

**Problem:** Whitepaper says "highest heartbeat streak" but doesn't resolve ties.

**Decision:** Selection order, applied sequentially until a tiebreaker is decisive:
1. Highest `heartbeat_streak`
2. Earliest `registered_at` timestamp (longer-standing backup wins)
3. Lexicographically lowest `tee_instance_id` (deterministic final tiebreaker)

All three fields stored in `backup_agents` table.  
Guardians applying this rule against identical DB snapshots always converge  
on the same target. Coordination-free by construction.

Random jitter 0–30 seconds on backup agent activation (thundering herd prevention).  
Documented and intentional — keep it.

---

## 3. Component Specifications

### 3.1 `packages/core`

**Responsibilities:**
- Vault key generation, sealing, unsealing
- Attestation handshake (admission protocol)
- Heartbeat protocol (ping/streak tracking)
- Succession protocol (selection, handshake, key rotation)
- Protocol database schema and encryption
- DB snapshot format and replication

**Does not contain:**
- Any ERC-8004 interaction (use `packages/erc8004-client`)
- Any x402 interaction (use `packages/x402-client`)
- Any application state (use `AgentStateAdapter`)
- Any application health logic (use `HealthCheckAdapter`)

**Entry points (exported):**
```typescript
export { VaultKeyManager } from './vault/key-manager'
export { AttestationService } from './attestation/service'
export { HeartbeatManager } from './heartbeat/manager'
export { SuccessionManager } from './succession/manager'
export { ProtocolDatabase } from './database/db'
export { SnapshotManager } from './database/snapshot'
export type {
  AgentStateAdapter,
  HealthCheckAdapter,
  AttestationProvider,
  ProtocolConfig,
  GuardianRecord,
  BackupAgentRecord,
} from './interfaces'
```

---

### 3.2 `packages/guardian`

**Responsibilities:**
- Liveness monitoring (ping-based, protocol level only)
- Succession initiation on liveness failure
- DB snapshot storage and validation
- ERC-8004 discovery on startup and re-discovery
- x402 payment for discovery
- Periodic re-attestation of primary and backup agents
- Peer registry (SQLite, WAL mode)

**Does not contain:**
- Any application-specific health checks
- Any fund, NFT, or trading logic
- Any Moltbook-specific logic

**Exposes `HealthCheckAdapter` hook:**  
Guardian accepts an optional `HealthCheckAdapter` at construction.  
If provided, calls it after each liveness check. Default: no-op.  
Application-specific guardians (e.g. Panthers) implement and inject the adapter.

---

### 3.3 `packages/boot`

**Responsibilities:**
- Human-assisted bootstrap only: creates the **first** primary agent VM via secretvm-cli
- EVM wallet funding (ETH for gas + USDC for x402 float) — seeds the agent's in-TEE wallet
- Post-deploy attestation verification
- Boot sequence orchestration

**Does NOT handle:**
- Backup agent VM creation (primary agent does this autonomously via REST API)
- Guardian VM creation (primary agent does this autonomously via REST API)
- Any fund-specific boot steps, NFT seeding, governance initialization

**Why boot only creates the primary:**
Once the primary agent is running, its in-TEE EVM wallet takes over all VM lifecycle
management via the SecretVM REST API + x402. The boot agent's job ends when the
primary is attested and funded. All subsequent VMs are self-provisioned.

**Exposes `BootHook` interface:**
Optional pre- and post-deploy hooks for application-specific steps.

**secretvm-cli invocation rules (from knowledge extraction):**
- Always write compose + env to `/tmp/boot-{name}-{Date.now()}`, delete in `finally`
- Parse domain with regex `([a-z]+-[a-z]+\.vm\.scrtlabs\.com)`, fallback to `'unknown'`
- Parse VM ID with regex `([0-9a-f-]{36})`, fallback to `'unknown'`
- Log a warning on fallback — never fail silently on parse
- Standard flags: `-s` (TLS), `-p` (persistence), `-r ghcr.io`
- Dev mode only: `-E dev` when `DEV_MODE=true`

**Autonomous VM management (packages/core/src/vm/secretvm-client.ts):**
The primary agent uses the SecretVM REST API directly for all self-provisioning.
See Section 7 for the full contract. This lives in `packages/core`, not `packages/boot`.

---

### 3.4 `apps/reference-agent`

**Responsibilities:**
- Moltbook agent implementation
- Implements `AgentStateAdapter` (Moltbook credentials, session tokens)
- Implements `HealthCheckAdapter` (Moltbook-specific health: session validity, API reachability)
- Exposes required protocol endpoints: `/discover` (x402-gated), `/api/evm-address`, `/workload`
- Uses `packages/core`, `packages/erc8004-client`, `packages/x402-client`

**This is the whitepaper's reference implementation.**  
It must be runnable standalone with clear documentation.  
It is the onboarding demo for third-party protocol adopters.

---

## 4. Interface Definitions

```typescript
// packages/core/src/interfaces.ts

/**
 * Implement this to plug application state into the protocol.
 * The protocol encrypts and replicates whatever this returns.
 * It knows nothing about what the state contains.
 */
export interface AgentStateAdapter {
  /** Serialize application state to bytes for DB storage */
  serialize(): Promise<Buffer>

  /** Restore application state from bytes after succession */
  deserialize(data: Buffer): Promise<void>

  /** Called once succession is complete and agent is primary */
  onSuccessionComplete(): Promise<void>

  /** Called to verify state integrity (optional, for guardian cross-reference) */
  verify?(): Promise<boolean>
}

/**
 * Implement this to add application-specific health checks.
 * Guardian calls this after each liveness ping.
 * Protocol only cares about the boolean result.
 */
export interface HealthCheckAdapter {
  check(): Promise<HealthCheckResult>
}

export interface HealthCheckResult {
  healthy: boolean
  severity: 'ok' | 'warning' | 'critical'
  reason?: string
}

/**
 * Implement this to swap attestation providers.
 * Default implementation uses SecretLabs PCCS.
 */
export interface AttestationProvider {
  /** Fetch TDX quote from cpu.html endpoint (multi-strategy parse) */
  fetchQuote(domain: string): Promise<string>

  /** Verify quote against PCCS, return RTMR3 */
  verifyQuote(quote: string): Promise<AttestationResult>
}

export interface AttestationResult {
  rtmr3: string
  valid: boolean
  tcbStatus: string
}

/**
 * Protocol configuration. All timing parameters are configurable.
 * Defaults are defined in packages/core/src/config.ts.
 */
export interface ProtocolConfig {
  // Timing
  heartbeatIntervalMs: number           // Default: 30_000 (30s)
  livenessFailureThreshold: number      // Default: 10 (5 min at 30s interval)
  reAttestationIntervalHours: number    // Default: 6
  dbSnapshotIntervalMs: number          // Default: 600_000 (10 min)
  peerStalenessThresholdMs: number      // Default: 1_800_000 (30 min)

  // Minimum guardian count
  minGuardianCount: number              // Default: 3

  // Approved measurements
  agentApprovedRtmr3: string[]         // Set at init from own RTMR3, stored in DB
  guardianApprovedRtmr3: string[]      // Env var GUARDIAN_APPROVED_RTMR3

  // PCCS endpoints
  pccsEndpoints: string[]              // Default: ['https://pccs.scrtlabs.com/dcap-tools/quote-parse']

  // x402
  discoveryPriceUsdc: number           // Default: 0.001
}

export interface GuardianRecord {
  id: string
  networkAddress: string
  teeInstanceId: string
  rtmr3: string
  admittedAt: Date
  lastAttestedAt: Date
  lastSeenAt: Date
  status: 'active' | 'pending_re_attestation' | 'inactive'
}

export interface BackupAgentRecord {
  id: string
  networkAddress: string
  teeInstanceId: string
  rtmr3: string
  registeredAt: Date
  heartbeatStreak: number
  lastHeartbeatAt: Date
  status: 'standby' | 'inactive'
}
```

---

## 5. Protocol Database Schema

All tables live in a single SQLite database, encrypted at rest using the vault key  
(AES-256-GCM). The schema below is the decrypted structure.

```sql
-- Protocol configuration. Single row. Set at initialization.
CREATE TABLE config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Required keys: agent_rtmr3, vault_key_version, initialized_at, erc8004_token_id

-- Registered guardians
CREATE TABLE guardians (
  id                  TEXT PRIMARY KEY,
  network_address     TEXT NOT NULL,
  tee_instance_id     TEXT NOT NULL UNIQUE,
  rtmr3               TEXT NOT NULL,
  admitted_at         INTEGER NOT NULL,   -- Unix ms
  last_attested_at    INTEGER NOT NULL,
  last_seen_at        INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'pending_re_attestation', 'inactive'))
);

-- Registered backup agents
CREATE TABLE backup_agents (
  id                  TEXT PRIMARY KEY,
  network_address     TEXT NOT NULL,
  tee_instance_id     TEXT NOT NULL UNIQUE,
  rtmr3               TEXT NOT NULL,
  registered_at       INTEGER NOT NULL,   -- Unix ms — used in tiebreaker
  heartbeat_streak    INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at   INTEGER,
  status              TEXT NOT NULL DEFAULT 'standby'
    CHECK (status IN ('standby', 'inactive'))
);

-- Application state (encrypted blob, managed by AgentStateAdapter)
CREATE TABLE agent_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),  -- Single row
  state_blob    BLOB NOT NULL,
  updated_at    INTEGER NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1
);

-- Nonce cache for replay protection
CREATE TABLE used_nonces (
  nonce       TEXT PRIMARY KEY,
  used_at     INTEGER NOT NULL
);
-- FIFO eviction: delete oldest when count > 10000

-- Event log (protocol events only, not application events)
CREATE TABLE protocol_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT NOT NULL,
  detail      TEXT,
  occurred_at INTEGER NOT NULL
);
-- Event types: admission, heartbeat_reset, succession_initiated,
--              succession_complete, re_attestation, guardian_removed
```

**Encryption scope:**  
The entire database file is encrypted. Guardians receive the encrypted file.  
They hold the vault key and can decrypt to read backup agent records for succession.  
The `agent_state` blob is additionally encrypted by `AgentStateAdapter.serialize()` —  
double-encrypted by design. Application state has an extra layer.

**SQLite settings (always):**
```typescript
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')
db.pragma('foreign_keys = ON')
```

**All upserts use `INSERT ... ON CONFLICT DO UPDATE`.**  
Never check-then-write. This is a known race condition from prior implementation.

---

## 6. Cryptographic Specifications

### Vault Key

- **Algorithm:** AES-256-GCM
- **Generation:** `crypto.randomBytes(32)` inside TEE at first boot
- **Sealing key derivation:** `SHA256("idiostasis-vault-seal-v1|{teeInstanceId}")`
- **Sealed format:**
```json
{
  "ciphertext": "<base64>",
  "iv": "<hex, 12 bytes>",
  "authTag": "<hex, 16 bytes>",
  "version": 1
}
```
- **Storage priority on load:**
  1. TEE-sealed path: `/dev/attestation/keys/vault-key`
  2. File-sealed path: `/data/vault-key.sealed`
  3. Generate new (first boot only — log this explicitly)
- **Never passed as plaintext env var.** Boot agent does not hold the vault key.  
  Agent generates it internally. This is a hard departure from prior implementation.

### Key Exchange (Admission Handshake)

```
Connecting node → Primary:
  { role, x25519_pubkey, ed25519_pubkey, sig(ed25519, x25519_pubkey), nonce, rtmr3 }

Primary verifies:
  1. sig valid (ed25519 over x25519_pubkey)
  2. rtmr3 matches approved value for claimed role
  3. nonce not in used_nonces table

Primary → Connecting node:
  { x25519_pubkey(primary), ed25519_pubkey(primary), sig(ed25519, x25519_pubkey) }

Both sides:
  shared_secret = X25519(my_private, their_public)
  
If role == guardian:
  Primary encrypts vault key with AES-256-GCM using shared_secret
  Primary sends { encrypted_vault_key, encrypted_db_snapshot }

If role == backup_agent:
  Primary writes heartbeat entry only
  Vault key not sent at admission
```

### DB Snapshot Format

```json
{
  "encryptedDb": "<base64>",
  "iv": "<hex>",
  "authTag": "<hex>",
  "sequenceNum": 42,
  "checksum": "<SHA256 hex of plaintext db>",
  "signedBy": "<tee_instance_id>",
  "signature": "<Ed25519 signature over encryptedDb+sequenceNum+checksum>",
  "timestamp": 1741824000000
}
```

Sequence numbers must be monotonically increasing. Reject out-of-order.  
Out-of-order delivery has been observed in prior implementation.

### Payload Signing (Per-Exchange Lightweight Auth)

Every DB push signed by primary's Ed25519 key.  
Guardian verifies against previously-attested public key.  
This is the Tier 1 re-attestation check from Decision 5.

---

## 7. External Service Contracts

### SecretVM: Two Distinct Paths

There are two ways to create VMs. They are used in different contexts. Do not conflate them.

**Path A — secretvm-cli (human bootstrap only)**  
Used by the boot agent for the very first VM creation (primary agent).  
No agent EVM wallet exists yet. A human-held API key authenticates.  
This is the only place secretvm-cli is used. Treat it as a one-time bootstrap tool.

**Path B — SecretVM REST API with x402 (autonomous, all subsequent VMs)**  
Used by the primary agent to autonomously create backup agents and guardian VMs.  
Authenticated via the agent's EVM wallet (generated inside TEE, never leaves enclave).  
Funded via x402 USDC payments. No human involvement. No API key.  
Base URL: `https://secretai.scrtlabs.com`

---

### Path A: secretvm-cli

```typescript
// Always this exact pattern — from knowledge extraction
const tmpDir = `/tmp/boot-${name}-${Date.now()}`
try {
  // write compose + env to tmpDir
  // invoke CLI
  // parse output
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

// Domain extraction — always regex with fallback
const domainMatch = output.match(/([a-z]+-[a-z]+\.vm\.scrtlabs\.com)/)
const domain = domainMatch?.[1] ?? 'unknown'
if (domain === 'unknown') logger.warn('Failed to parse domain from secretvm-cli output')

// VM ID extraction
const vmIdMatch = output.match(/([0-9a-f-]{36})/)
const vmId = vmIdMatch?.[1] ?? 'unknown'
```

---

### Path B: SecretVM REST API (Autonomous VM Management)

This is the primary agent's self-provisioning path. Lives in `packages/core/src/vm/secretvm-client.ts`.

#### Authentication

Every request must include three headers computed fresh per request:

```typescript
interface AgentRequestHeaders {
  'x-agent-address': string    // EVM wallet address
  'x-agent-signature': string  // Signature of request hash
  'x-agent-timestamp': string  // Unix ms timestamp
}

// Payload to sign:
// `${METHOD}${path}${body}${timestamp}`
// request_hash = SHA-256 hex of payload
// signature = signMessage(request_hash bytes) with EVM private key

function buildHeaders(
  evmPrivateKey: string,
  method: string,
  path: string,
  body: string
): AgentRequestHeaders {
  const timestamp = String(Date.now())
  const payload = `${method}${path}${body}${timestamp}`
  const requestHash = sha256hex(payload)
  const signature = evmSignMessage(requestHash, evmPrivateKey)
  return {
    'x-agent-address': evmAddressFromKey(evmPrivateKey),
    'x-agent-signature': signature,
    'x-agent-timestamp': timestamp,
  }
}
```

**The server rejects replays.** Each request requires a fresh timestamp.  
The private key never leaves the TEE enclave — signing happens inside the enclave.

#### Checking Balance

```typescript
// GET /api/agent/balance
// Response: { balance: "<minor units string>" }
// 6 decimals — divide by 1_000_000 for USDC
async function getBalance(): Promise<number>
```

#### Topping Up via x402

```typescript
// POST /api/agent/add-funds
// Body: { amount_usdc: "<string>" }
// If 402 returned: retry with x402 payment-signature header
// On success: { balance: "<minor units string>", payment_method: "x402" }

async function addFunds(amountUsdc: number): Promise<void> {
  const body = stableStringify({ amount_usdc: String(amountUsdc) })
  const headers = buildHeaders(evmKey, 'POST', '/api/agent/add-funds', body)
  
  let res = await fetch(`${BASE_URL}/api/agent/add-funds`, {
    method: 'POST', body, headers: { ...headers, 'Content-Type': 'application/json' }
  })
  
  if (res.status === 402) {
    // x402 payment required — pay and retry
    const paymentSig = await x402Client.payFromChallenge(await res.json())
    res = await fetch(`${BASE_URL}/api/agent/add-funds`, {
      method: 'POST', body,
      headers: { ...headers, 'Content-Type': 'application/json', 'payment-signature': paymentSig }
    })
  }
  
  if (!res.ok) throw new Error(`add-funds failed: ${await res.text()}`)
}
```

**Minimum balance requirement:** Agent must have balance ≥ AGENT_MIN_BALANCE (100 minor units = 0.0001 USDC) before VM creation will be accepted.

#### Creating a VM (Multipart — Critical Signing Note)

**The multipart signing scheme is non-obvious and must be implemented exactly.**  
Do NOT sign the raw multipart body. Sign a stable JSON representation instead.

```typescript
// Signed payload for create-vm is NOT the raw multipart body.
// It is a stable JSON string of this structure:
const signingPayload = stableStringify({
  fields: { name, vmTypeId, ...otherFields },
  file: {
    fieldname: 'dockercompose',
    originalname: 'docker-compose.yml',
    mimetype: 'application/x-yaml',
    size: composeBytes.length,
    sha256: sha256hex(composeBytes),
  }
})
// stableStringify = JSON.stringify with sorted keys, no extra spaces

const headers = buildHeaders(evmKey, 'POST', '/api/vm/create', signingPayload)

// Then send as actual multipart/form-data (not the JSON)
const form = new FormData()
form.append('name', name)
form.append('vmTypeId', vmTypeId)
form.append('dockercompose', new Blob([composeBytes], { type: 'application/x-yaml' }), 'docker-compose.yml')
// Optional fields:
form.append('eip8004_registration', JSON.stringify(erc8004Params))  // ERC-8004 registration
form.append('cloudflareApiKey', cloudflareApiKey)
form.append('fs_persistence', 'true')
// skip_attest defaults to "1" for agent requests — leave it unless explicitly testing

const res = await fetch(`${BASE_URL}/api/vm/create`, {
  method: 'POST', body: form, headers
})
// Response includes: id, name, vmDomain, vmId, vmUid, status
```

**If balance is insufficient, server returns 402.** Top up then retry.

#### Polling VM Status

```typescript
// GET /api/agent/vm/:id
// Response: { id, name, status, vmDomain, vmId, vmUid, created_at, updated_at }
// 404 if VM doesn't exist or doesn't belong to this agent

async function getVmStatus(vmId: string): Promise<VmStatus>
```

#### Full Autonomous VM Provisioning Flow

This is the flow the primary agent uses to self-provision backup agents and guardians:

```
1. GET /api/agent/balance
   → if insufficient: POST /api/agent/add-funds (x402)

2. POST /api/vm/create
   → multipart with signed payload
   → include eip8004_registration for guardians and primary
   → include cloudflareApiKey for public-facing VMs
   → if 402 (insufficient balance): top up, retry

3. GET /api/agent/vm/:id (poll until status == 'running')
   → poll every 15s, max 10 min

4. Initiate attestation handshake with new VM
5. Write to DB (guardians table or backup_agents table)
```

#### `stableStringify` — Required Utility

```typescript
// Used everywhere request bodies need to be signed.
// JSON.stringify with sorted keys, no whitespace.
function stableStringify(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort(), undefined)
}
// Note: For nested objects, sort recursively.
// The server uses the same algorithm. Any key ordering mismatch = signature failure.
```

### cpu.html Quote Extraction

```typescript
// Always multi-strategy, always in this order
async function extractQuoteFromHtml(html: string): Promise<string> {
  // Strategy 1: <pre> tag
  const preMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i)
  if (preMatch?.[1]?.trim()) {
    logger.debug('attestation: extracted via <pre>')
    return preMatch[1].trim()
  }

  // Strategy 2: <textarea> tag
  const textareaMatch = html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/i)
  if (textareaMatch?.[1]?.trim()) {
    logger.debug('attestation: extracted via <textarea>')
    return textareaMatch[1].trim()
  }

  // Strategy 3: longest hex string >= 128 chars
  const hexMatches = html.match(/[0-9a-fA-F]{128,}/g) ?? []
  const longestHex = hexMatches.sort((a, b) => b.length - a.length)[0]
  if (longestHex) {
    logger.debug('attestation: extracted via longest hex string')
    return longestHex
  }

  // Strategy 4: longest base64 string >= 128 chars
  const b64Matches = html.match(/[A-Za-z0-9+/]{128,}={0,2}/g) ?? []
  const longestB64 = b64Matches.sort((a, b) => b.length - a.length)[0]
  if (longestB64) {
    logger.debug('attestation: extracted via longest base64 string')
    return longestB64
  }

  throw new Error('attestation: all extraction strategies failed')
}
```

### PCCS Verification

```typescript
// Always per-request TLS agent — never global NODE_TLS_REJECT_UNAUTHORIZED
import https from 'https'

const tlsAgent = new https.Agent({ rejectUnauthorized: false })

async function verifyWithPccs(quote: string, endpoints: string[]): Promise<AttestationResult> {
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        body: JSON.stringify({ quote }),
        headers: { 'Content-Type': 'application/json' },
        // @ts-ignore — Node.js fetch accepts agent
        agent: tlsAgent,
        signal: AbortSignal.timeout(10_000),
      })
      const data = await response.json()
      // Always check both field name variants
      const rtmr3 = data.rtmr3 ?? data.rtmr_3
      if (!rtmr3) throw new Error('PCCS response missing rtmr3 field')
      return { rtmr3, valid: true, tcbStatus: data.tcb_status ?? 'unknown' }
    } catch (err) {
      logger.warn(`PCCS endpoint ${endpoint} failed: ${err}`)
      continue
    }
  }
  throw new Error('All PCCS endpoints exhausted')
}
```

### ERC-8004 Client (`packages/erc8004-client`)

```typescript
interface ERC8004Client {
  // Register agent on Base — called once at boot
  register(params: RegistrationParams): Promise<{ tokenId: number; txHash: string }>

  // Update network address after succession
  updateEndpoint(tokenId: number, newEndpoint: string, wallet: EVMWallet): Promise<string>

  // Find agents by RTMR3 match in workload service
  findByRtmr3(rtmr3: string): Promise<AgentRegistration[]>

  // Get single registration by token ID
  getRegistration(tokenId: number): Promise<AgentRegistration>
}
```

### x402 Client (`packages/x402-client`)

```typescript
interface X402Client {
  // Fetch URL, handle 402 automatically, retry with payment
  fetchWithPayment(url: string, wallet: SolanaWallet): Promise<Response>

  // Check if response requires payment
  is402(response: Response): boolean

  // Extract payment terms from 402 response
  getPaymentTerms(response: Response): PaymentTerms
}
```

---

## 8. Configuration Reference

### All Protocol Parameters

| Parameter | Env Var | Type | Default | Notes |
|-----------|---------|------|---------|-------|
| Heartbeat interval | `HEARTBEAT_INTERVAL_MS` | number | 30000 | ms |
| Liveness failure threshold | `LIVENESS_FAILURE_THRESHOLD` | number | 10 | missed pings |
| Re-attestation interval | `RE_ATTESTATION_INTERVAL_HOURS` | number | 6 | hours |
| DB snapshot interval | `DB_SNAPSHOT_INTERVAL_MS` | number | 600000 | ms |
| Peer staleness threshold | `PEER_STALENESS_MS` | number | 1800000 | ms |
| Min guardian count | `MIN_GUARDIAN_COUNT` | number | 3 | |
| Backup jitter max | `BACKUP_JITTER_MAX_MS` | number | 30000 | thundering herd |
| Discovery price | `X402_DISCOVERY_PRICE_USDC` | number | 0.001 | USDC |
| Re-attestation failure limit | `RE_ATTEST_FAILURE_LIMIT` | number | 2 | consecutive |
| PCCS endpoints | `PCCS_ENDPOINTS` | string | scrtlabs primary | comma-separated |

### Environment Variables by Component

**Agent:**
```
# Identity
ERC8004_TOKEN_ID=              # Set after first registration, persisted
AGENT_ROLE=primary|backup      # Determines boot behavior

# Chain
BASE_RPC_URL=
ERC8004_REGISTRY_ADDRESS=
SOLANA_RPC_URL=                # For x402 USDC settlement

# SecretVM
CLOUDFLARE_DOMAIN=             # Cloudflare proxy domain

# Dev
DEV_MODE=false
DEV_ATTESTATION_HASH=          # Only valid when DEV_MODE=true
```

**Guardian:**
```
GUARDIAN_APPROVED_RTMR3=       # Comma-separated list of approved agent RTMR3s
BASE_RPC_URL=
ERC8004_REGISTRY_ADDRESS=
SOLANA_RPC_URL=                # For x402 payments
X402_DISCOVERY_WALLET=         # Solana wallet keypair for discovery fees
PCCS_ENDPOINTS=                # Optional alternates
```

**Boot Agent:**
```
SECRETVM_API_KEY=
CLOUDFLARE_API_KEY=
BASE_RPC_URL=
ERC8004_REGISTRY_ADDRESS=
AGENT_EVM_SEED_USDC=5          # USDC to seed agent EVM wallet
AGENT_EVM_SEED_ETH=0.01        # ETH to seed agent EVM wallet
DEPLOYER_PRIVATE_KEY=          # Funding wallet — zeroed after use (implement this)
DEV_MODE=false
```

---

## 9. Test Requirements

The following tests are mandatory. CI fails without them.

### Unit Tests (each package)

- `packages/core/vault`: Key generation, sealing, unsealing, version field present
- `packages/core/attestation`: RTMR3 extraction (all 4 strategies), PCCS field name variants
- `packages/core/heartbeat`: Streak increment, streak reset on miss, tiebreaker ordering
- `packages/core/succession`: Deterministic selection with ties (all 3 tiebreaker levels)
- `packages/core/database`: Upsert idempotency, sequence monotonicity enforcement, nonce dedup
- `packages/erc8004-client`: Registration, endpoint update, lookup by RTMR3
- `packages/x402-client`: 402 detection, payment term extraction, retry logic

### Integration Tests

- Guardian admits primary agent on correct RTMR3, rejects on incorrect
- Guardian rejects backup agent presenting guardian RTMR3 (role confusion)
- DB snapshot rejected if sequence number is not monotonically increasing
- Re-attestation cycle completes without disrupting active connections
- PCCS fallback: primary endpoint down, secondary used successfully

### End-to-End Succession Test (mandatory gate for any release)

Located in `packages/core/test/succession-e2e/`

**Scenario:**
1. Boot primary agent (dev mode, local process)
2. Admit 3 guardians
3. Admit 2 backup agents (different heartbeat streaks)
4. Kill primary process
5. Verify: guardians detect failure within `livenessFailureThreshold * heartbeatInterval + 5s`
6. Verify: backup agent with highest streak is selected
7. Verify: vault key rotated (old key cannot decrypt new snapshots)
8. Verify: ERC-8004 registry update fires on new primary
9. Verify: remaining guardians stand down after registry update
10. Verify: old primary cannot re-enter with stale vault key

**Pass criteria:** All 10 steps complete within configurable timeout. Zero assertions fail.

---

## 10. Docker and CI Notes

### Dockerfiles

All images use `node:22-slim` (not alpine) — required for glibc dependency of secretvm-cli.  
Confirmed in prior implementation.

All images must have `.dockerignore`. Missing this was a known issue.

Container images pinned by digest in all docker-compose files.  
**Never use mutable tags.** RTMR3 measures the docker-compose.yaml content literally.  
A mutable tag means docker-compose doesn't change when the image does.  
Attestation would pass for the wrong image. This is a critical security requirement.

### CI Pipeline

- Build only changed packages (Turborepo)
- Tag format: `{branch}-{7charSHA}`
- Succession e2e test is a required CI step, not optional
- No release without passing succession e2e

---

## 11. What This Repo Explicitly Does Not Contain

This list exists so Claude Code does not add these things even if they seem helpful:

- NFT logic of any kind
- Trading logic of any kind
- Fund governance or staking
- Solana programs (NFT shares, governance)
- Panthers Fund references
- Telegram bot logic
- Withdrawal fee calculations
- Per-NFT balance tracking
- Any reference to Magic Eden, Jupiter, or other fund-specific services

If any of the above appears to be required to implement something in this spec,  
stop and flag it. It means something leaked from the application layer.

---

*End of implementation spec. Version 1.0 — 2026-03-13*
*Next: Claude Code executes against this document. Flag any ambiguity before building.*

---

## ADDENDUM — Decision 8: Autonomous Guardian Management

**Context:** The agent must ensure the guardian network never drops below 3.
It does this by owning and managing exactly one guardian VM itself.
External (third-party) operators can run additional guardians independently.

**The agent-owned guardian:**
- Provisioned by the primary agent via the SecretVM REST API on first boot
- Tracked in the `guardians` table with `provisioned_by = 'agent'`
- The agent holds the VM ID and can restart or recreate it at will
- External guardians have `provisioned_by = 'external'`

**State machine — agent evaluates on every heartbeat cycle:**

```
external_stable = guardians where provisioned_by='external'
                  AND status='active'
                  AND have crossed liveness_failure_threshold (not just 1 missed ping)

if external_stable < 2:
    ensure agent-owned guardian is running
    if agent guardian is down: restart it (same VM ID if possible, else recreate)
    reset external_stable_since = null

if external_stable >= 2:
    if external_stable_since is null: set external_stable_since = now
    if (now - external_stable_since) >= 24 hours:
        if agent-owned guardian is running: spin it down

if external_stable drops below 2 after threshold was crossed:
    spin agent-owned guardian back up immediately
    reset external_stable_since = null  ← 24-hour clock restarts from zero
```

**Liveness definition for this logic:**
"External guardian down" means it has crossed the same LIVENESS_FAILURE_THRESHOLD
used by the succession protocol — not just a single missed ping. Prevents VM churn
from transient hiccups. Reuses existing protocol machinery, no new logic needed.

**The 24-hour clock resets on any drop below 2 stable external guardians.**
If a flapping external causes the agent to spin back up, the full 24 hours
must be satisfied again from scratch before the agent spins down again.

**DB additions required:**
```sql
-- Additional columns on guardians table:
provisioned_by        TEXT NOT NULL DEFAULT 'external'
                        CHECK (provisioned_by IN ('agent', 'external')),
agent_vm_id           TEXT,            -- SecretVM VM ID, only set when provisioned_by='agent'
external_stable_since INTEGER          -- Unix ms timestamp, null if clock not running
```

**x402 cost awareness:**
Before provisioning a guardian VM, agent checks balance via GET /api/agent/balance.
If insufficient, tops up via x402 then proceeds. Internal agent concern, not protocol.
