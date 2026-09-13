# Idiostasis Protocol

Attestation-gated confidential state persistence for autonomous agents.

## Problem

Every backup and recovery mechanism in current use assumes a human holds master credentials. This makes autonomous agents impossible to build: an agent that can be accessed or recovered by a human is not autonomous, it is automated.

Decentralized storage solves availability but not key custody. Centralized secrets managers and secret sharing schemes both require a human trust authority somewhere in the chain. Naive TEE replication defers the problem rather than solving it — it still requires a mechanism to control which TEEs are authorized to receive state. That mechanism is what Idiostasis provides.

## Protocol Design

Idiostasis distributes encrypted agent state across a permissionless network of guardian nodes. Admission is controlled entirely by TEE attestation against a verified code hash. No human authorizes entry at any point.

**Vault Key**
Generated inside the primary agent's TEE at initialization. Never exists outside an attested enclave. Any TEE running the correct codebase, verified by code hash, may receive it. The code hash is the policy.

**Network Formation**
Backup agents and guardians discover the primary via the ERC-8004 on-chain registry and initiate attestation handshakes. On pass, network addresses are written to the protocol database. Guardians receive the vault key and an encrypted database copy. Backup agents receive a heartbeat tracking entry only.

**Heartbeat**
The primary pings all registered participants at a fixed interval. Backup agent response streaks are tracked in the database. Guardians monitor the absence of pings from the primary to detect liveness failure.

**Succession**
When the primary goes offline, each guardian independently decrypts its local database copy, selects the backup agent with the highest heartbeat streak, and initiates an attestation handshake. The selection rule is deterministic — all guardians converge on the same target without coordination. The first successful handshake completes succession. The new primary updates the ERC-8004 registry and all remaining guardians stand down.

## Security Properties

**Confidentiality**
Agent state is encrypted at rest. The vault key never exists outside an attested enclave. Guardian operators provision hardware but cannot extract secrets from their own enclaves. The TEE enforces this unconditionally.

**Admission integrity**
Only nodes running the exact authorized codebase can join the network. A single byte change to the container definition changes the RTMR3 measurement register and fails attestation. There is no partial pass.

**Succession correctness**
A false succession trigger causes temporary disruption only; the successor is a valid attested agent and assets remain protected. A fraudulent backup agent cannot win selection because admission requires attestation.

**Availability / confidentiality separation**
Guardian operators have availability power — they can go offline. They have no confidentiality power. This separation is enforced by hardware, not policy.

The protocol is only as strong as the underlying TEE hardware. If attestation is broken at the hardware level, the protocol provides no guarantees. This is a known property of all TEE-based systems.

## Architecture Notes

- Trust anchor is a verified code hash, not an operator address — this keeps the protocol chain-agnostic and TEE-provider-agnostic.
- ERC-8004 is used for on-chain identity/discovery over provider-specific alternatives, to keep the protocol portable across TEE platforms (SecretVM, Phala dStack, Azure, etc.).
- The canonical trust root is the on-chain ERC-8004 registry, not any convenience frontend.
- State custody and succession coordination are treated as separable jobs — conflating them was the source of an earlier, over-engineered guardian model.
- A `ConfigStore` DB-first pattern seeds from env vars on first boot only; subsequent boots read solely from the DB, enabling succession with zero human intervention.

## Deployments

- **Panthers Fund** — flagship deployment. An autonomous NFT trading fund on Base mainnet, running inside Intel TDX (SecretVM), serving as a live proof-of-concept for the protocol.
- **Moltbook** — secondary reference implementation. A standalone agent whose sole job is to pay its own compute costs through social engagement and donations, demonstrating the full autonomy story (paused pending x402-based Secret AI API access).

## Status

Active development. Full protocol specification and security analysis are in the complete whitepaper.

## Stack

- TEE: Intel TDX via SecretVM
- On-chain identity: ERC-8004
- Payments: x402
- Primary chain: Base mainnet (Base Sepolia for testing)
