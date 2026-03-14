# Idiostasis Knowledge Extraction

Extracted from `attested_capital` codebase — 2026-03-13.
Internal reference for building idiostasis-protocol without re-learning painful lessons.

---

## 1. SecretVM / TEE Findings

### secretvm-cli Invocation
- **Exact flags**: `secretvm-cli -k <API_KEY> vm create -n <NAME> -t <SIZE> -d <COMPOSE_PATH> -e <ENV_PATH> -r ghcr.io -s -p [-E dev]`
  - `-s` = TLS enabled (always)
  - `-p` = persistence (data survives reboots)
  - `-E dev` = SSH access — only if `DEV_MODE=true`
  - `-r ghcr.io` = registry for pulling images
- **Workaround**: Compose and env files written to `/tmp/boot-${name}-${Date.now()}` with epoch suffix to avoid collisions. Deleted in `finally` block. (`boot-agent/src/steps/deploy-vms.ts:145-146`)
- **CLI output parsing is fragile**: Domain extracted via regex `([a-z]+-[a-z]+\.vm\.scrtlabs\.com)`, VM ID via `([0-9a-f-]{36})`. Falls back to `'unknown'` silently if format changes. (`deploy-vms.ts:130-141`)

### RTMR3 Behavior
- **Read from**: `/dev/attestation/rtmr3` as UTF-8 string, `.trim()`. Not hex-parsed. (`boot-agent/src/index.ts:49-65`)
- **Fallback chain**: RTMR3 → `/dev/attestation/mr_enclave` → `SHA256('boot-agent-dev')` (dev hash)
- **In agent**: Parsed from `/mnt/secure/self_report.txt` via regex `/RTMR3:\s*([0-9a-fA-F]+)/`. Also checked via `RTMR3` env var set by boot-agent. (`panthers-fund/src/agent/tee.ts`)
- **What it actually measures**: The rootfs + the exact `docker-compose.yaml` content = the GHCR image identity
- **Critical implication**: Docker-compose tags must be hardcoded strings, never env vars, because the YAML file itself is measured. Comment in `boot-agent/docker-compose.yml:3-5` explains this.
- **PCCS response format**: Quote fields appear as either `rtmr_3` or `rtmr3` (inconsistent). Code checks both. (`verify-and-fund-agent.ts:192`)

### /cpu.html Endpoint
- **URL**: `https://{domain}:29343/cpu.html` — port 29343 is hardcoded, non-negotiable
- **Returns HTML**, not JSON. Quote is embedded in the page.
- **Extraction is multi-strategy** because format is inconsistent: tries `<pre>`, `<textarea>`, longest hex string (128+ chars), longest base64 string (128+ chars). (`verify-and-fund-agent.ts:61-81`)
- **TLS**: Self-signed cert. Code temporarily sets `NODE_TLS_REJECT_UNAUTHORIZED=0` during fetch, restores after. Race condition if parallel fetches happen. (`verify-and-fund-agent.ts:83-95`)

### TEE Signing Service
- **Endpoint**: `http://172.17.0.1:49153/sign` (docker host bridge IP, hardcoded)
- **Request**: `{ key_type: "ed25519", payload: base64 }`
- **Response**: `{ signature: base64 }`
- **Timeout**: 5 seconds
- **Public key**: Extracted from last 32 bytes of PEM at `/mnt/secure/docker_public_key_ed25519.pem`
- **Fallback**: Dev mode uses Node.js `crypto` ed25519. Detection is automatic.

### TEE Instance ID
- **Priority**: `/mnt/secure/self_report.txt` SHA256 (first 32 chars) → `/mnt/secure/tdx_attestation.txt` SHA256 → `/sys/kernel/config/tsm/report/outblob` → `http://169.254.169.254/attestation` → dev fallback (hostname + persistent random seed at `/tmp/.panthers-tee-dev-seed`)

---

## 2. Attestation Handshake Findings

### Boot-Agent → Agent Flow (one-shot, `verify-and-fund-agent.ts`)
1. **Poll `/api/fund-address`** every 15s, max 10 min. Wait for `{ solanaAddress }`.
2. **GET `https://{domain}:29343/cpu.html`** — extract quote from HTML (multi-strategy parse).
3. **POST quote to PCCS** (`https://pccs.scrtlabs.com/dcap-tools/quote-parse`). Get back RTMR3 measurement. 10s timeout.
4. **Transfer ETH** (balance minus 0.0005 reserve) to agent wallet. Wait for receipt.
5. **POST `/api/set-hostname`** with `{ hostname }`. 30s timeout. Non-fatal if fails.

### Agent → Guardian Mutual Attestation
- **Agent self-attests**: Generates `{ teeInstanceId, codeHash, timestamp, nonce, signature(HMAC-SHA256) }`. Dev secret: `'dev-attestation-secret'`.
- **Guardian verifies agent**: Receives attestation, checks against approved measurements.
- **Agent verifies guardian**: Fetches guardian's `/cpu.html`, verifies via PCCS, extracts RTMR3.
- **First-guardian auto-enrollment**: If agent has no approved measurements yet, it locks to the first guardian's RTMR3. Stored in `governance_config` table as `tee_measurements` JSON array. (`panthers-fund/src/agent/index.ts:~451`)
  - **Lesson**: This means onboarding order matters. First guardian sets the trust root.

### Vault Key Exchange
- X25519 keypair generated per TEE instance
- Ed25519 signature of X25519 pubkey proves same TEE owns both keys
- AES-256-GCM wrapping of vault key during exchange
- Endpoint: `/api/attestation` on agent

### Known Issues
- **Hostname set twice**: Once in `index.ts` (~line 148-187), again in `verify-and-fund-agent.ts` (~line 237-254). Redundant.
- **No retry logic anywhere**: Fixed 15s polling, no exponential backoff.
- **Two separate polling loops** for agent startup (one checks `/status`, another checks `/api/fund-address`) — could be merged.
- **PCCS is single point of failure** for attestation verification.
- **Comment says "zero the deployer private key" but code never does it.** (`verify-and-fund-agent.ts:5-11`)
- **Attestation/funding is entirely optional** — skipped if `DEPLOYER_PRIVATE_KEY` or `agentDomain` missing. Boot succeeds without it.

---

## 3. Vault Key Lifecycle Findings

### Generation
- `randomBytes(32)` — AES-256. (`boot-agent/src/steps/generate-vault-key.ts`, `panthers-fund/src/vault/key-manager.ts`)

### Agent-Side Loading (4-tier, `key-manager.ts`)
1. `VAULT_KEY` env var (hex string)
2. TEE-sealed path: `/dev/attestation/keys/vault-key`
3. File-sealed path: `/data/vault-key.sealed` (AES-256-GCM JSON)
4. Generate new (first boot only)

### Sealing
- **Sealing key derivation**: `SHA256("vault-seal|{teeInstanceId}|{codeHash}")`
- **Algorithm**: AES-256-GCM, 12-byte random IV
- **Sealed format**: `{ ciphertext(base64), iv(hex), authTag(hex), version: 1 }`
- Auto-persists on first boot (tries TEE path first, then file path)

### Persistence Issue
- **Boot-agent passes vault key as plaintext env var** to agent VM via `.env` file. (`deploy-vms.ts:96`)
- Also stores it in sealed config at `/mnt/secure/boot-config/agent.sealed.json`.
- **The sealing key is ephemeral** — derived in memory, never persisted. If TEE instance ID or code hash changes (upgrade), old sealed data is unrecoverable.
- **Lesson for idiostasis**: Plan vault key migration strategy for upgrades. The current design means a code update breaks sealing key derivation.

### What Vault Key Encrypts
- DB snapshots for guardian sync (every 10 min)
- Snapshot format: `{ encryptedDb(base64), iv(hex), authTag(hex), sequenceNum, checksum(SHA256 hex), attestationQuote? }`
- Wrapped key exchange via ECDH during attestation

---

## 4. Guardian Network Findings

### Discovery
- **Agent discovery**: `EvmDiscoveryClient` reads Base Sepolia registry (not Solana). Re-discovers every 5 min. (`guardian-network/src/shared/evm-discovery.ts`)
- **Graceful fallback**: If registry read fails, uses cached endpoint. Warning log only.
- **No caching layer**: Every 5-min cycle re-queries contract from scratch.
- **Peer discovery**: HTTP-based, NOT mutual. Guardians discover each other **via the agent** (agent's `backup_agents` table in DB snapshots). No direct peer-to-peer discovery protocol.

### peers.ts SQLite
- WAL mode enabled, 5000ms busy timeout, foreign keys ON. (`shared/db.ts`)
- **Race condition in upsert**: Check-then-update/insert is not atomic. Should use `INSERT ... ON CONFLICT`. (`peers.ts:17-52`)
- No PRAGMA integrity_check. No corruption recovery logic.
- 30-minute staleness threshold for peer pruning.

### Heartbeat Timing (all hardcoded, no env vars)
| Parameter | Value | File |
|-----------|-------|------|
| Agent heartbeat timeout | 300s (5 min) | `shared/registry-client.ts:15` |
| Sentry health check interval | 30s | `guardian/main.ts:535` |
| Peer staleness threshold | 30 min | `guardian/peers.ts:12` |
| Health check interval | 10 min | `guardian/main.ts:394` |
| RPC testing interval | 30 min | `guardian/main.ts:410` |
| Proposal resolution interval | 5 min | `guardian/main.ts:469` |
| Peer pruning interval | 15 min | `guardian/main.ts:416` |
| Delegation update interval | 60 min | `guardian/main.ts:433` |
| Self-registration refresh | 5 min | `guardian/main.ts:568` |
| EVM registry re-discovery | 5 min | `guardian/main.ts:551` |

### health-monitor.ts Tuning
- Balance drop ≥20% → `critical`, ≥10% → `warning`. (`health-monitor.ts:77-78`)
- **False positive mitigation**: Transition-based anomalies only — alerts on status *change*, not every consecutive failure. (`health-monitor.ts:45-52`)
- NFT count change alerts on ANY change (no threshold) — intended for security, not performance.
- 10s timeout for fund manager check. No retry. No circuit breaker. All thresholds hardcoded.

### RPC Scoring (`rpc-tester.ts`, `rpc-registry.ts`)
- **Asymmetric**: +1 for success, -3 for failure. Biased toward deprecation.
- `trial` → `active` at reputation ≥10. Any → `deprecated` at reputation ≤-20.
- 10s timeout per test. Sequential testing (slow with many RPCs).
- `getBest(chain)` returns highest-reputation active endpoint.
- **No latency-based scoring** despite tracking `latency_ms`.

### Trust & Attestation
- One-way trust. No periodic re-attestation. Trust store is write-only — once trusted, always trusted.
- Nonce cache: 10,000 entries with FIFO eviction (replay protection). (`signed-envelope.ts:79-90`)
- DB snapshot sequence numbers checked for monotonicity — out-of-order delivery has occurred. (`db-sync.ts:209-214`)

---

## 5. Succession Protocol Status

### What's Implemented
- Heartbeat monitoring (30s checks). If `deactivated: true`, enters failover.
- **Ordered failover**: Reads decrypted DB snapshot → queries `backup_agents` table → filters by `last_heartbeat > 2 hours ago` → orders by `heartbeat_streak DESC, registered_at ASC` → pings each backup sequentially.
- Backup responds via `/api/backup/ready` with full attestation + registration details.
- First responsive backup gets proposed for registration via voting system.

### What's NOT Tested End-to-End
- **No real succession event has been triggered and completed.**
- `/api/backup/ready` endpoint exists in agent code but the guardian-side caller is a stub — no confirmation that backup actually took over.
- No state synchronization if backup needs to catch up on DB changes between last snapshot and takeover.
- No tie-breaking if multiple backups respond simultaneously.
- If all backups fail, manual intervention is required. (`guardian/main.ts:515`)

### Backup Agent Behavior
- `AGENT_ROLE=backup` → enters standby mode. No database, no trading.
- Polls registry every 30s. On primary failure (5 min heartbeat timeout):
  1. Random jitter 0-30s (prevents thundering herd)
  2. Re-check registry (another backup may have won)
  3. Request registration with guardian approval (75% threshold)
  4. If approved: fetch DB from guardians via `/api/recovery`
  5. Transition to primary, call `registerSelfOnChain()`
- Max 3 attempts with 10s delay between retries.
- **Safety**: No double-trading possible — backup has NO database until takeover completes AND it wins the registration race.

---

## 6. Solana Registry Findings

### Program ID Mismatch
- `declare_id!` in `lib.rs`: `CUrDTwtCvVDe8EAUvNfLaVK4NdLdpHpe92NFgh3SmSMb`
- `Anchor.toml` devnet: `5LrwsBBCh4xNUxVXv5s22UCamwXrduFNuLFGxSRtXwzX`
- **These don't match.** Program was redeployed; `declare_id!` wasn't updated. Anchor.toml takes precedence at deploy time.

### PDA Layout
- Seeds: `[b"entry", owner.key().as_ref()]` — one PDA per owner wallet.
- Account size: 399 bytes fixed. Endpoint field: 256-byte max String stored on-chain (expensive, could be a hash).
- Bump stored explicitly in account.

### SDK Quirks
- **IDL is hand-written** (`sdk/src/idl.ts`). Comment says "replace with auto-generated IDL from target/idl/" but this hasn't happened.
- **Manual Anchor discriminator**: `SHA256("global:" + name)[0..8]`. Avoids `@coral-xyz/anchor` runtime dependency.
- **memcmp filter bug**: Uses base58 `'1'` for 0x00 (Agent), `'2'` for 0x01 (Guardian). Works by accident for these specific bytes. May break for other entity types.
- Uses `VersionedTransaction` (v0) for future lookup table support. Not actually using lookup tables.

### Test Coverage Gaps
- Guardian entity type never tested (only Agent=0).
- No permission checks tested (unauthorized signer rejection).
- No endpoint length validation tested.
- No multi-entry scenarios.
- No SDK client or discovery method tests.

### Instructions
- 5 instructions: `register`, `heartbeat`, `update_endpoint`, `update_attestation`, `deactivate`
- `register` uses `init_if_needed` — creates or reactivates (soft-delete + re-register pattern)
- `deactivate` can be called on already-deactivated entries (no error)
- All modify instructions check `is_active` except `deactivate` itself
- Error codes: 6000 EndpointTooLong, 6001 InvalidEntityType, 6002 EntryInactive

### Deployment
- Uses Anchor CLI: `anchor build` → `anchor upgrade ... --program-id [ID] --provider.cluster devnet`
- Boot-agent Dockerfile installs Solana CLI + secretvm-cli (requires glibc → uses `node:22-slim` not alpine)
- Release profile: `overflow-checks = true, lto = "fat", codegen-units = 1` (security over speed)

---

## 7. Non-Obvious Implementation Decisions

### Architecture Pivot (documented in `DECISIONS_CONFIRMED.md`)
- **Solana = source of truth**, not database. NFT on-chain ownership is canonical. DB is a performance cache that can be rebuilt from blockchain.
- **Solana-only** — dropped ETH, Base, Secret Network chains. Removes ~40% code complexity and bridge risks.

### Individual Accounts, Not Pooled NAV
- Each NFT has its own tracked balance. Equal % returns regardless of entry time.
- Pooled NAV creates Ponzi dynamics (early buyers subsidized by late). (`ARCHITECTURE.md`)

### Guardian vs Sentry Split
- Guardians = infrastructure (permissionless, cheap, $5/month). Sentries = governance (must stake NFTs).
- Prevents Sybil: attacker spins 1000 guardians → 0% voting power. Only NFT stakers vote.

### 2% Withdrawal Fee + 0% P2P Fee
- P2P trades on Magic Eden = 0% (keep fund liquid). Full withdrawal = 2% (discourages exits, fee to remaining holders).

### Blocking Problems (from `autonomous_launch_problems.md`)
1. **Telegram bot token is human-controlled** — operator could impersonate agent. Proposed fix: autonomous phone provisioning via Twilio in TEE.
2. **Telegram blocks bot-to-bot communication** — discovery protocol broken. Fix: moved to Solana registry.
3. **Trustless discovery impossible** without human seed. Fix: Solana registry PDA.
4. **Config governance** requires SSH to TEE to change keys/endpoints. Breaks autonomy.

### Wallet Management
- BIP39 mnemonic (24 words), derivation `m/44'/501'/0'/0'`
- Generated once, stored in DB `wallet_state` table
- Deterministic — same mnemonic always yields same Solana keypair
- **Lesson**: Wallet is in DB. DB recovery from guardians recovers wallet. No separate key backup needed.

### DB Snapshot Sync
- Every 10 minutes to all guardians (`*/10 * * * *`)
- Encrypted with vault key (AES-256-GCM)
- Sequence numbers enforce monotonicity (rejects stale/replayed snapshots)
- Guardian stores latest only (not history)
- Recovery: backup tries each guardian endpoint in sequence until one succeeds

### Docker Images
- boot-agent: `node:22-slim` (needs glibc for Solana CLI + secretvm-cli)
- agent + guardian: `node:22-alpine` (smaller)
- GitHub workflow builds only changed components, tags with `ref_name-7charSHA`
- Missing `.dockerignore` files noted — causes slow Docker context

---

## 8. TODOs and HACKs Found in Codebase

Only 2 TODOs found. No HACK/FIXME/WORKAROUND/KLUDGE/XXX comments.

| File | Line | Content |
|------|------|---------|
| `panthers-fund/src/nft/minter.ts` | 106 | `uri: '', // TODO: set to metadata JSON URI when available` |
| `panthers-fund/src/nft/minter.ts` | 174 | `// TODO: Implement full burn with proof when Bubblegum burn is available` |

---

## 9. Things to Never Do Again

### SecretVM
- **Never use env var substitution in docker-compose image tags** — RTMR3 measures the YAML file literally. Tags must be hardcoded strings.
- **Never trust a single HTML parsing strategy for `/cpu.html`** — the quote format has varied. Always implement multiple extraction strategies.
- **Never rely on `NODE_TLS_REJECT_UNAUTHORIZED=0` in async code** — it's a global process mutation. Race condition with parallel fetches. Find a per-request TLS bypass.
- **Never parse secretvm-cli output with exact string matching** — use regex with fallbacks. The output format is not stable.

### Attestation
- **Never assume PCCS response field names are stable** — `rtmr_3` vs `rtmr3` both appear. Check both.
- **Never skip zeroing the deployer private key** — the code comments say to do it but never actually does. Implement it.
- **Never make attestation/funding a blocking requirement for boot** — keep it optional so the agent can start even if PCCS is down.
- **Never assume first-guardian auto-enrollment is safe without operator awareness** — the first guardian sets the trust root permanently. Add explicit confirmation or logging.

### Vault Key
- **Never derive sealing key from code hash without a migration path** — code updates change `codeHash`, which changes the sealing key, which makes old sealed data unrecoverable. Plan key migration for upgrades from day one.
- **Never pass vault key as both sealed config AND plaintext env var** — pick one. Current code does both. (`deploy-vms.ts:96`)

### Solana Registry
- **Never let `declare_id!` and `Anchor.toml` diverge** — causes confusion. Update both on every deploy.
- **Never hand-write IDL and forget to replace it** — use the auto-generated one from `anchor build`.
- **Never use base58 encoding tricks for memcmp filters** — the current `'1'` for 0x00 works by accident. Use proper byte serialization.
- **Never store full endpoint URLs on-chain** — 256-byte String field paying rent forever. Store a hash or use a cheaper off-chain registry.

### Guardian Network
- **Never use check-then-write for SQLite upserts** — use `INSERT ... ON CONFLICT`. Current `peers.ts` has a race condition.
- **Never use asymmetric reputation scoring (+1/-3) without tuning** — one failure requires 3 successes to recover. Endpoints get deprecated too aggressively.
- **Never assume trust store entries expire** — current implementation is write-only. Once trusted, always trusted. Add periodic re-attestation.
- **Never test RPC endpoints sequentially** — it's slow. Parallelize.
- **Never hardcode all timing parameters** — make them configurable via env vars for production tuning.

### Succession
- **Never ship a succession protocol without a full end-to-end test** — current implementation has never been triggered for real. Test it before it matters.
- **Never assume only one backup responds** — need proper tie-breaking. Current code takes first responder, but network timing is non-deterministic.

### General
- **Never set hostname in two separate code paths** — causes confusion and wasted requests. Do it once.
- **Never skip `.dockerignore`** — causes slow builds and potentially leaks secrets into image context.
- **Never assume Telegram bots can communicate with each other** — they can't. Bot-to-bot is a Telegram platform limitation. Use HTTP/on-chain for inter-component communication.
