# Idiostasis Protocol
### Attestation-Gated Confidential State Persistence for Autonomous Agents

**Status:** Working Outline — In Progress
**Version:** 0.1
**Date:** 2026

---

## Structure Overview

1. Abstract
2. Introduction
3. Background / Prior Art
4. System Overview
5. Protocol Specification
6. Security Analysis
7. Implementation
8. Future Work
9. Conclusion
10. References

---

## 1. Abstract
> *To be written last.*

---

## 2. Introduction

### Step 1: Where agents are today
- AI agents in 2026 are predominantly task-oriented tools — they execute instructions, assist workflows, and return results to human operators
- The defining characteristic of today's agents is the human in the loop — credentials are human-held, backups are human-managed, decisions are human-approved
- This model is powerful but fundamentally bounded — the agent is an extension of human capability, not an independent actor
- Define the spectrum clearly: from simple chatbots to complex multi-step workflow agents — all still tethered to human oversight

### Step 2: Where they're heading
- The logical endpoint of agent development is full autonomy — agents that hold assets, manage their own credentials, execute continuously without human approval cycles
- Early examples already exist: autonomous trading agents, AI-managed treasuries, agents that own onchain wallets
- The economic incentive is clear — removing humans from the loop removes latency, bias, and single points of failure
- This is not speculative — the infrastructure investment flowing into autonomous agent frameworks signals this direction clearly

### Step 3: The infrastructure gap
- Full autonomy creates a class of problem that has never existed before — secrets that belong to no human
- In every prior computing context, a human ultimately holds the master key — sysadmin, security team, founder
- A truly autonomous agent cannot have this — the moment a human holds a backup key, the agent is not autonomous, it is automated
- Current infrastructure has no answer to the question: how does an autonomous agent's confidential state survive failure?

### Step 4: TEEs as the emerging context
- Trusted Execution Environments are hardware-enforced secure enclaves that execute code in isolation — even the host machine operator cannot inspect what runs inside
- TEEs are the natural deployment environment for autonomous agents precisely because they enforce the separation of secrets from humans at the hardware level
- Intel TDX, AMD SEV, and similar technologies are making TEE deployment increasingly accessible
- However TEEs introduce a new fragility — they are ephemeral. When a TEE restarts, unprotected state is lost

### Step 5: The unsolved problem
- The TEE solves the human access problem but creates a persistence problem — how do you back up state that no human can read?
- Existing backup solutions all assume a human who knows the encryption password — they fail by definition in the autonomous context
- Decentralized storage solves availability but not confidentiality — you can store encrypted data anywhere, but key management still requires a human or a centralized service
- Secret sharing and MPC distribute trust but require always-online participants and ultimately assume human-held shares
- This gap has been acknowledged in the literature but never formally solved

### Step 6: What this paper contributes
- We introduce Idiostasis Protocol — the first formal protocol for attestation-gated confidential state persistence for autonomous agents
- Idiostasis solves the autonomous backup problem by distributing encrypted agent state across a permissionless network of attested guardians
- Admission to the guardian network is controlled entirely by TEE attestation against a verified code hash — no human authorization required at any point
- We provide a full protocol specification, security analysis, and reference implementation
- Idiostasis establishes a new infrastructure primitive — one that makes truly autonomous agents viable at scale for the first time

---

## 3. Background / Prior Art

### The Autonomous Backup Problem
- Traditional software systems assume a human ultimately holds master credentials — this assumption is so fundamental it is rarely stated explicitly
- The emergence of truly autonomous agents running in TEEs creates for the first time a class of system where this assumption cannot hold
- We survey the solution space a developer would naturally reach for, and demonstrate that each category fails at the same underlying point — the assumption of a human in the trust chain

### Category 1: Decentralized Storage
- The most intuitive response to any backup problem — store encrypted state on IPFS, Arweave, Filecoin, or similar
- Solves availability — data persists across node failures, is censorship resistant, geographically distributed
- Fails on confidentiality — decentralized storage is agnostic to what it stores. The encryption key still needs to live somewhere
- Key management remains entirely unsolved — who holds the decryption key? In every existing implementation, a human or a centralized service does
- Decentralized storage is a necessary component of a complete solution but cannot be the solution itself

### Category 2: Centralized Secrets Managers
- Purpose-built solutions for secret storage — HashiCorp Vault, AWS Secrets Manager, Azure Key Vault
- Mature, battle-tested, widely deployed — the obvious enterprise answer
- Fails by definition in the autonomous context — the operator of the secrets manager has access. AWS has access. The Vault administrator has access
- Introduces a centralized trust anchor that directly violates autonomous ownership
- Additionally creates a single point of failure — if the secrets manager is unavailable at restart, the agent cannot recover its state

### Category 3: Secret Sharing and MPC
- Shamir's Secret Sharing and Multi-Party Computation are the cryptographically sophisticated answers — split the key across N parties, require M to reconstruct
- Genuinely distributes trust — no single party holds the complete secret
- Fails in the autonomous context for two reasons:
  - Shares must ultimately be held by someone — in practice humans or always-online services
  - Reconstruction requires M parties to be simultaneously available and cooperative at the exact moment the agent restarts — fragile in production
- MPC adds computational complexity without resolving the fundamental question of who holds the shares
- These approaches work well for human-managed systems and are important prior art — they simply were not designed for the autonomous agent case

### Category 4: Privacy-Native Blockchains
- Platforms like Secret Network offer confidential smart contracts — encrypted state stored on chain, inaccessible to node operators
- A compelling partial solution — state is confidential and persistent without a centralized custodian
- Fails because the agent still needs a key to access its own encrypted state after restart
- Key management for that access key remains unsolved — the agent must retrieve it from somewhere, which reintroduces the original problem one level up
- Additionally introduces latency, cost, and throughput constraints that make it unsuitable as a primary state persistence layer for high-frequency autonomous agents
- Note: privacy blockchains remain a valuable component of the broader autonomous agent stack — just not a complete solution to this specific problem

### Category 5: Naive TEE Replication
- The most technically sophisticated instinct — run a second TEE as a backup, replicate state between them
- Closer to the right direction than any other category — TEE-to-TEE communication can be confidential and attested
- Fails at the admission question — who decides which TEEs are authorized to receive the backup?
  - If a human decides: autonomous ownership is violated. The human is now a trust authority over the agent's secrets
  - If a smart contract decides: you need a mechanism to prove the receiving TEE is running the correct code — which is exactly what Idiostasis formalizes
- Naive TEE replication implicitly requires Idiostasis or an equivalent protocol to be sound
- **Critical clarification:** Idiostasis does not eliminate humans from infrastructure operation. It eliminates humans from the trust chain. A guardian operator provisions hardware but is cryptographically prevented from accessing agent secrets. Admission is controlled by attestation against a verified code hash — not by human authorization. The operator is a physical host, not a trust authority.

### Closing: The Common Failure Mode
- Every category above fails at the same underlying point — each assumes a human somewhere in the trust chain, whether explicitly as a key holder or implicitly as an admission authority
- This is not a flaw in their design — these systems were built for human-operated infrastructure
- Idiostasis is the first protocol specifically designed for the case where no such human can exist
- It does not replace these technologies — decentralized storage, TEEs, and attestation are all components of the Idiostasis stack. It provides the missing layer that makes them composable for truly autonomous agents

---

## 4. System Overview

### 4.1 Design Principles
- No human in the trust chain at any point
- Permissionless participation gated by attestation alone
- Agent is economically self-sufficient (x402)
- Deterministic, coordination-free succession

### 4.2 Actors
- **Primary agent** — runs in TEE, holds vault key, manages DB, pays own VM rent via x402, registered on-chain via ERC-8004
- **Backup agents** — idle TEEs registered in protocol DB only, respond to primary heartbeat pings
- **Guardians** — permissionless attested nodes, store encrypted DB backup, monitor primary liveness, trigger succession independently
- **ERC-8004 registry** — on-chain identity layer for primary agent only; updated by successor after takeover

### 4.3 The Vault Key
- Generated inside the TEE at initialization
- Shared with any TEE that passes attestation against the correct code hash
- Never exists outside an attested enclave — attestation is the sole admission mechanism

### 4.4 Network Formation
- Backup agents and guardians discover primary via ERC-8004 registry
- Each attests with the primary agent — on pass, their network address is written to the DB
- Primary begins pinging all registered participants at interval X
- Primary tracks each backup agent's response streak in the DB
- Primary pushes DB copy to guardians on any DB change

### 4.5 Normal Operation
- Primary runs continuously — pinging, updating DB, pushing state to guardians
- Pays its own infrastructure costs via x402 with no human financial dependency

### 4.6 Succession
- Primary liveness threshold crossed — guardians independently detect via missed pings
- Each guardian independently applies deterministic selection rule: highest current heartbeat streak in DB
- All guardians converge on same target backup agent without coordination
- Target backup agent attests against code hash — on pass, receives encrypted DB and vault key from guardian
- Successor updates ERC-8004 registry — live primary in registry signals succession complete, remaining guardians stand down
- If highest-streak backup is unreachable, guardians fall through to next highest deterministically

### 4.7 On-Chain DB Verification *(optional extension)*
- Guardians cross-reference DB state against on-chain state to verify accuracy
- Applicable when agent state has a verifiable on-chain mirror (e.g. trading fund with on-chain positions)
- Not required by the core protocol — included as an extension for implementations where it is relevant

---

## 5. Protocol Specification

### 5.1 Initialization
- Primary agent starts in TEE, generates vault key inside enclave
- DB initialized with empty backup agent and guardian tables
- Primary registers on-chain via ERC-8004

### 5.2 Admission
- Backup agent or guardian discovers primary via ERC-8004
- Initiates attestation handshake with primary
- Primary verifies code hash — pass: network address written to DB / fail: rejected, no DB entry
- Guardians on admission receive: vault key + encrypted DB copy + read-only DB access
- Backup agents on admission receive: heartbeat tracking entry in DB; vault key granted only upon succession

### 5.3 Heartbeat Protocol
- Primary pings all registered participants every X
- Each ping response increments backup agent's streak in DB
- Missed ping resets streak
- Liveness failure defined as primary missing Y consecutive pings from guardian's perspective

### 5.4 DB Replication
- Any DB change triggers encrypted push to all registered guardians
- Guardians hold vault key and can read DB contents — required to locate and contact backup agents during succession
- In applicable implementations, guardians may also use DB access to cross-reference agent state against on-chain data

### 5.5 Succession Protocol
- Guardian detects primary liveness failure (Y missed pings)
- Guardian decrypts local DB copy using vault key, selects highest heartbeat streak backup agent
- Contacts backup agent, initiates attestation handshake
- On pass: transmits encrypted DB and vault key to backup agent
- Backup agent decrypts inside TEE, resumes operation as new primary, updates ERC-8004 registry
- Fallthrough: if target backup agent unreachable, guardian selects next highest streak deterministically

### 5.6 Protocol Parameters
- X: ping interval
- Y: liveness failure threshold (consecutive missed pings)
- Minimum recommended guardian count
- Streak calculation and reset rules

---

## 6. Security Analysis

### 6.1 Threat Model
- Primary threat: human interference with autonomous agent's assets and data
- Protocol goal: make it cryptographically impossible for any human to access agent state or redirect assets, regardless of infrastructure access

### 6.2 Confidentiality Guarantees
- Agent state encrypted, vault key never leaves attested enclave
- Guardian holds vault key but is itself an attested TEE — operator cannot extract it
- No party outside the attested codebase can read agent state at any point in the lifecycle

### 6.3 Attestation as Trust Anchor
- Code hash verification is the sole admission mechanism — the entire protocol is only as strong as TEE attestation
- If TEE attestation is broken at the hardware level, the protocol provides no guarantees — this is a known property of all TEE-based systems, not specific to Idiostasis

### 6.4 Succession Attack Surface
- False succession trigger: possible, not a security breach — only a valid attested agent can receive the handoff, assets remain safe
- Fraudulent backup agent winning selection: not possible — admission requires attestation, unattested agents cannot enter the DB
- Multiple guardians contacting same backup simultaneously: benign — all converge on same target, backup serializes

### 6.5 Availability vs Confidentiality Separation
- Guardian operator has availability power only — can go offline, cannot read secrets
- Mitigated by network redundancy — no single guardian's cooperation required for state recovery

### 6.6 Known Limitations
- Protocol security is bounded by TEE hardware integrity — microarchitectural attacks and side channels are implementation concerns outside protocol scope

---

## 7. Implementation

### 7.1 Reference Implementation Overview
- Panthers Fund as reference implementation
- Demonstrates Idiostasis in production context: autonomous AI trading fund
- Validates core protocol guarantees under real operating conditions

### 7.2 Technology Stack
- **TEE:** Intel TDX via SecretVM
- **Agent chain:** Base (ERC-8004 registry, x402 payments)
- **Fund chain:** Solana (NFT transactions, fund trading only)
- **Transport:** HTTPS — TEE attestation deemed sufficient trust anchor, Tor complexity not justified at this stage
- **Container runtime:** Docker, workload defined via docker-compose.yaml
- **Image registry:** GHCR (GitHub Container Registry)

### 7.3 Attestation Implementation
- Trust anchor: RTMR3 measurement — cryptographic hash of root filesystem and docker-compose.yaml
- Any single byte change to docker-compose.yaml changes RTMR3 → attestation fails → vault key does not transfer
- Different GHCR image → attestation fails → vault key does not transfer
- Confirmed in testing: attestation is binary and unforgiving — correct code hash or rejection
- Reference measurement registers for context:
  - MRTD: firmware hash
  - RTMR0: firmware configuration
  - RTMR1: Linux kernel
  - RTMR2: kernel command line and initramfs
  - RTMR3: root filesystem + docker-compose.yaml *(protocol trust anchor)*

### 7.4 Protocol DB — Reference Implementation
- Guardian table: attested network addresses
- Backup agent table: attested network addresses, heartbeat streak
- NFT ownership table: amounts locked per NFT (Panthers-specific)
- DB encrypted at rest, vault key required for access

### 7.5 Validated Behaviors
- Vault key does not transfer if attestation fails
- Single byte change to docker-compose.yaml triggers attestation failure
- Mismatched GHCR image triggers attestation failure

---

## 8. Future Work

### 8.1 Cross-TEE Vendor Support
- Idiostasis currently specified against Intel TDX via SecretVM
- Generalization to AMD SEV and ARM CCA would broaden the deployment surface
- Non-priority at current stage — Intel TDX is the primary target

### 8.2 Guardian Governance Layer
- Guardians currently have no mechanism to authorize agent upgrades or configuration changes
- A governance layer would allow guardians to collectively approve a new code hash, enabling controlled protocol upgrades without breaking the trust model
- Distinct from fund-level governance — this is protocol-level change management

### 8.3 Vault Key Rotation on Succession
- When a new agent becomes primary, the vault key should rotate
- Prevents a recovered old primary from re-entering the network with a stale valid key
- Closes the split-brain attack vector where two agents believe they are primary simultaneously

---

## 9. Conclusion

### 9.1 The Problem Restated
- Autonomous agents have no human to hold a backup key — every existing backup solution fails by definition in this context
- This is not a gap in any single technology; it is a gap in the infrastructure layer itself

### 9.2 What Idiostasis Provides
- Attestation-gated confidential state persistence — encrypted agent state distributed across a permissionless guardian network
- Admission controlled entirely by TEE attestation against a verified code hash — no human authorization at any point
- Deterministic, coordination-free succession — the agent recovers without human intervention

### 9.3 Broader Significance
- Idiostasis is not a feature — it is a missing infrastructure primitive
- Truly autonomous agents cannot operate at scale without a solution to the confidential state persistence problem
- This protocol establishes the foundation that makes autonomous agent deployment viable

### 9.4 Call to Action
- Idiostasis is an open protocol
- Reference implementation available
- Invitation for adoption, independent guardian operators, and protocol contribution

---

## 10. References
> *Pending*

---

*Working document — do not distribute*
