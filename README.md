Idiostasis Protocol -  whitepaper can be found here https://github.com/MrGarbonzo/idiostasis-protocol/blob/main/docs/IDIOSTASIS_PROTOCOL_WHITEPAPER.pdf

Attestation-gated persistence for autonomous agents. Lets an agent survive the death of the machine it runs on without a human ever holding its keys.

Status: testnet. Not production. Currently blocked on a SecretVM CLI dependency for VM lifecycle control.

The problem

An agent that a human can recover is not autonomous. It is automated.

If you want an agent to hold funds, sign transactions, and keep operating without supervision, it needs to survive infrastructure failure on its own. That means answering a hard question:

When the agent dies, how do you guarantee it respawns exactly once?

Too few and the agent is gone along with whatever it was holding. Too many and you have duplicates signing against the same funds.

The usual answer is a coordinator that decides who takes over. But a coordinator is a human in the loop, which is the thing we are trying to eliminate.

How it works

The primary deploys its own redundancy. On launch, the agent stands up its own backups and monitors. The monitors are called guardians.

State is encrypted and distributed. The vault key is generated inside the primary's TEE and never exists outside an attested enclave. Guardians hold encrypted copies of agent state that they cannot read on their own.

Admission is gated on attestation, not identity. Any TEE that attests to the verified code hash may receive the vault key. Nothing else may. There is no owner address, no admin, no allowlist. Trust is anchored to the code that is running, not to whoever deployed it.

Guardians confirm death, then elect a successor. Liveness is tracked by heartbeat. When the primary stops responding, guardians independently decrypt their local copies and deterministically select the backup with the highest heartbeat streak. Same inputs, same result, no communication between guardians required. They converge without a coordinator.

The failure mode that made this hard

The selection logic above is the easy half. The subtle problem is upstream of it.

A backup already holds the vault key. It has to, in order to take over. But holding the key means it can sign as primary at any moment, including while the real primary is alive and merely slow to respond. Nothing in the election logic prevents that.

The result is two agents that both believe they are primary, both signing against the same funds.

The fix is temporal gating. A backup cannot act on the key until enough time has passed that the primary's silence is unambiguous rather than latency.

This is worth calling out because the naive implementation runs fine. You would never catch it in testing. It only fails at the exact moment it matters.

Design position: custody anchored to code, not identity

Most key management for agents derives keys from an owner address. Same owner, same derivation path, same keypair, on any admitted node. That makes agents portable and lets them change their own code freely, because the keys follow the identity rather than the workload.

Idiostasis anchors custody to a code hash instead. Any TEE running the verified codebase may receive the vault key, and nothing else may.

The tradeoff is real and runs both directions:

	Identity-anchored	Code-anchored (this)
Agent can rewrite its own code	Yes	Not without a succession mechanism
Modified or compromised code gets the keys	Yes	No
Trust anchor	Whoever controls the address	The measurement

Neither is strictly better. This one trades self-modification for the guarantee that only verified code ever holds secrets.

Repository layout
apps/reference-agent    reference implementation
packages/               protocol packages
docker/                 container definitions
docs/                   whitepaper
scripts/                tooling
IMPLEMENTATION_SPEC.md  build reference
KNOWLEDGE_EXTRACTION.md

TypeScript monorepo, Turborepo.

What runs on top of it

attested_capital is an autonomous trading agent built on this protocol. It owns its own funds, trades them, pays its own infrastructure costs out of the proceeds, and dies when it fails.

Notes

Trust is in the code, not the operator. An agent that can be accessed or recovered by a human is not autonomous.
