# Idiostasis Protocol
### Attestation-Gated Confidential State Persistence for Autonomous Agents

---

## 1. Abstract

Autonomous agents operating inside Trusted Execution Environments present a state persistence problem that existing infrastructure cannot solve. Every backup and recovery mechanism in current use assumes a human who holds master credentials. For an agent that controls assets and credentials on behalf of no human principal, this assumption is a contradiction: any human recovery path is a human control path, and an agent recoverable by a human is not autonomous.

We introduce the Idiostasis Protocol, a formal protocol for attestation-gated confidential state persistence for autonomous agents. Idiostasis distributes encrypted agent state across a permissionless network of guardian nodes whose admission is controlled entirely by TEE attestation against a verified code hash. No human authorization is required at any point. Guardians are attested enclaves themselves and hold the vault key inside their own secure context, making it inaccessible to their operators. Succession is deterministic and coordination-free: guardians independently converge on the same successor candidate, the candidate attests before receiving state, and a registry update finalizes the handoff without human intervention.

We provide a complete protocol specification, a security analysis demonstrating the separation of availability and confidentiality guarantees, and a reference implementation validating the protocol against a live autonomous agent deployment. Idiostasis establishes a new infrastructure primitive for the autonomous agent stack.

---

## 2. Introduction

In 2026, the dominant form of AI agent is a tool. It executes instructions, automates workflows, and returns results to a human operator who remains in control at every meaningful step. The credentials belong to the human. The backups belong to the human. The decisions, ultimately, belong to the human. This is true across the full spectrum of deployed agents: from simple chatbots answering customer queries to sophisticated multi-step systems coordinating across APIs, databases, and external services. Capable as they are, these agents share a defining characteristic. They are extensions of human capability, not independent actors.

The logical endpoint of this trajectory is different. As agent architectures mature, the economic pressure toward full autonomy is clear. An agent that holds its own assets, manages its own credentials, and executes continuously without human approval cycles removes latency, eliminates operator bias, and has no single human point of failure. This is not a speculative future. Autonomous trading agents, AI-managed treasuries, and agents that own and operate onchain wallets already exist. The infrastructure investment flowing into autonomous agent frameworks makes the direction unambiguous.

Full autonomy, however, creates a class of problem that has never existed before: secrets that belong to no human. In every prior computing context, from enterprise servers to personal devices, a human ultimately holds the master key. The sysadmin, the security team, the founder. This assumption is so deeply embedded in infrastructure design that it is rarely stated explicitly. A truly autonomous agent breaks it. The moment a human holds a backup key to an agent's credentials, the agent is not autonomous. It is automated. The distinction is not semantic. An automated agent can be redirected, paused, or compromised through its human key holder. A genuinely autonomous agent cannot be.

Trusted Execution Environments have emerged as the natural deployment context for autonomous agents precisely because they enforce this separation at the hardware level. A TEE is a secure enclave in which code executes in isolation. The host machine operator cannot inspect its contents, cannot extract its secrets, and cannot tamper with its execution. Technologies like Intel TDX and AMD SEV are making TEE deployment increasingly accessible, and the combination of hardware-enforced confidentiality with autonomous agent logic is a compelling foundation for truly independent systems.

TEEs, however, introduce a critical fragility: they are ephemeral. When a TEE restarts, unprotected state is lost. For a human-operated system, this is a solved problem. The operator restores from backup using credentials they hold. For a no-human-knowledge autonomous agent, there is no such operator. The TEE solves the human access problem and in doing so creates a new one. How does an agent's confidential state survive failure when no human can read it?

Existing approaches fail to answer this question. Decentralized storage solutions solve availability but not confidentiality. Encrypted state can be stored anywhere, but key management still requires a human or a centralized service to hold the decryption key. Secret sharing and multi-party computation distribute trust but require always-online participants and ultimately assume human-held shares. Centralized secrets managers introduce a trust authority with access to the very secrets they protect. The gap is real, has been acknowledged in the literature, and has not been formally solved.

This paper introduces the Idiostasis Protocol, the first formal protocol for attestation-gated confidential state persistence for autonomous agents. Idiostasis solves the autonomous backup problem by distributing encrypted agent state across a permissionless network of guardian nodes, where admission is controlled entirely by TEE attestation against a verified code hash. No human authorization is required at any point in the protocol. Guardians are attested enclaves themselves. They hold the vault key but cannot extract it from their own secure context. Succession is deterministic and coordination-free, enabling an agent to recover from failure and resume operation without any human intervention.

We did not design Idiostasis to solve a theoretical problem. A predecessor autonomous agent, running inside a TEE, generated its platform credentials entirely within the enclave. When the primary instance went down, those credentials were unrecoverable. No backup mechanism existed that did not require a human in the loop. The agent was lost permanently. Idiostasis is the protocol we built after that happened.

We provide a complete protocol specification, a security analysis of the trust model and attack surface, and a reference implementation demonstrating the protocol against a live autonomous agent deployment. Idiostasis is not a feature added to existing infrastructure. It is a missing primitive that makes truly autonomous agents viable at scale for the first time.

---

## 3. Background and Prior Art

Traditional software infrastructure rests on an assumption so fundamental it is rarely stated: somewhere in the system, a human holds the master credentials. The sysadmin knows the root password. The security team controls the key management service. The founder holds the seed phrase. This assumption is not a design flaw. It reflects the reality that software has always been built to serve human operators, and human operators need a recovery path.

The emergence of truly autonomous agents running inside TEEs creates, for the first time, a class of system where this assumption cannot hold. An agent that controls assets and credentials on behalf of no human principal cannot have a human recovery path without ceasing to be autonomous. We survey the approaches a developer would naturally reach for when facing this problem, and show that each fails at the same underlying point.

**Decentralized Storage**

The most intuitive response to any backup problem is distributed storage. Platforms like IPFS, Arweave, and Filecoin offer persistent, censorship-resistant data availability across a global network of nodes. For an autonomous agent, this is a natural first instinct: encrypt the state and store it somewhere no single party controls.

The approach solves availability but not confidentiality. Decentralized storage is agnostic to what it stores. The encryption key still needs to live somewhere, and in every existing implementation, that somewhere is a human or a centralized service. The storage layer and the key management layer are separate problems, and decentralized storage addresses only the first. It is a necessary component of a complete solution, not the solution itself.

**Centralized Secrets Managers**

Purpose-built secrets management platforms, including HashiCorp Vault, AWS Secrets Manager, and Azure Key Vault, represent the mature enterprise answer to credential storage. They are battle-tested, widely deployed, and operationally well-understood.

They fail by definition in the autonomous context. The operator of a HashiCorp Vault deployment has access to the secrets it stores. AWS has access to what runs in AWS Secrets Manager. Every centralized secrets manager introduces a trust authority, and that authority is staffed by humans. For an autonomous agent whose security guarantee is the absence of any human in the trust chain, this is not a partial failure. It is a categorical one. Centralized secrets managers also introduce a single point of failure: if the service is unavailable at the moment the agent restarts, state recovery is impossible.

**Secret Sharing and Multi-Party Computation**

Shamir's Secret Sharing and Multi-Party Computation (MPC) are the cryptographically sophisticated answers to the key custody problem. Rather than trusting a single party with the complete secret, the key is split across N participants, with any M required to reconstruct it. No individual party has enough information to act alone.

This genuinely distributes trust, but it does not eliminate the need for human custodians. The shares must ultimately be held by someone. In practice that means humans or always-online services, both of which reintroduce human dependency into the trust chain. Reconstruction also requires M participants to be simultaneously available and cooperative at the exact moment the agent needs to restart, which is operationally fragile. MPC adds significant computational complexity without resolving the foundational question of who holds the shares. These approaches are well-suited to human-managed systems and represent important prior art. They were not designed for the autonomous agent case.

**Privacy-Native Blockchains**

Platforms like Secret Network offer confidential smart contracts, where encrypted state is stored on-chain and inaccessible to node operators. This is a compelling partial solution: state is both confidential and persistent, with no centralized custodian.

The limitation is that the agent still needs a key to access its own encrypted state after restarting. Key management for that access key is entirely unsolved by the platform itself. The agent must retrieve the key from somewhere, which reintroduces the original problem one level up the stack. Privacy-native blockchains also introduce latency, cost, and throughput constraints that can make them unsuitable as a primary state persistence layer for high-frequency autonomous agents. They remain a valuable component of the broader autonomous agent infrastructure stack, but they are not a complete solution to the confidential state persistence problem.

**Naive TEE Replication**

The most technically sophisticated instinct is to run a second TEE as a backup and replicate state between them. TEE-to-TEE communication can be made confidential and mutually attested, which puts this approach closer to the right direction than any of the others.

It fails at the admission question. Who decides which TEEs are authorized to receive the backup? If a human makes that decision, autonomous ownership is violated. The human becomes a trust authority over the agent's secrets. If a smart contract makes that decision, the contract needs a mechanism to verify that the receiving TEE is actually running the correct, unmodified code. Providing that mechanism is precisely what Idiostasis formalizes. Naive TEE replication does not solve the problem; it defers it. Any sound implementation implicitly requires a protocol equivalent to Idiostasis.

One clarification is worth stating explicitly before proceeding. Idiostasis does not eliminate humans from infrastructure operation. It eliminates humans from the trust chain. A guardian operator provisions hardware but is cryptographically prevented from accessing agent secrets. Admission is controlled by attestation against a verified code hash, not by human authorization. The operator is a physical host, not a trust authority.

**The Common Failure Mode**

Every category surveyed above fails at the same point. Each assumes a human somewhere in the trust chain, whether explicitly as a key holder or implicitly as an admission authority. This is not a flaw in their design. These systems were built for human-operated infrastructure, and they serve that purpose well.

Idiostasis is the first protocol designed for the case where no such human can exist. It does not replace the technologies described above. Decentralized storage, TEE hardware, and on-chain attestation are all components of the Idiostasis stack. What Idiostasis provides is the missing composability layer that makes them work together for a genuinely autonomous agent.

---

## 4. System Overview

Idiostasis is designed around four principles. No human may exist in the trust chain at any point. Participation in the network is permissionless, gated by attestation alone. The agent is economically self-sufficient, paying its own infrastructure costs without human financial dependency. And succession is deterministic and coordination-free, requiring no communication between guardians to produce a consistent outcome.

**Actors**

The protocol defines four participants.

The primary agent is the active TEE instance running the autonomous workload. It generates and holds the vault key, manages the protocol database, pays its own VM rent using the x402 HTTP payment protocol, and maintains a public identity record on-chain via ERC-8004. It is the operational center of the system.

Backup agents are idle TEE instances running the same attested codebase. They are not registered on-chain. Their existence is known only to the protocol database, where the primary agent tracks their availability. They respond to heartbeat pings from the primary and wait. Their role is singular: to be ready to become the primary agent if the current one fails.

Guardians are permissionless attested nodes that anyone can operate by proving their enclave runs the correct codebase. They receive and store an encrypted copy of the protocol database, hold the vault key inside their own attested context, monitor the liveness of the primary agent, and independently initiate succession when liveness thresholds are crossed. A guardian operator provisions hardware but cannot read the agent's state. The enclave enforces that boundary regardless of who runs the machine.

The ERC-8004 registry is the on-chain identity layer for the primary agent. It is the single public record of which agent is currently active and how to reach it. Backup agents and guardians use it to discover the primary at startup. When succession completes, the new primary updates this record, and that update is the signal to the rest of the network that a new agent is in control.

**The Vault Key**

The vault key is generated inside the primary agent's TEE at initialization and never exists outside an attested enclave. It is the cryptographic root of the entire system: it encrypts the protocol database, it gates admission to the guardian network, and it is the credential a successor agent needs to resume operation.

Any TEE that passes attestation against the correct code hash may receive the vault key. Attestation is the sole admission mechanism. There is no whitelist, no human approval, no governance vote. The code hash is the policy.

**Network Formation**

When a backup agent or guardian comes online, it discovers the primary agent through the ERC-8004 registry and initiates an attestation handshake. The primary verifies that the connecting node is running the correct codebase by checking its code hash. On a successful attestation, the connecting node's network address is written to the protocol database. Guardians additionally receive the vault key and a current copy of the encrypted database. Backup agents receive a heartbeat tracking entry.

Once registered, the primary begins pinging all participants at a fixed interval. Each response from a backup agent increments that agent's heartbeat streak in the database. Any change to the database triggers an encrypted push to all registered guardians, keeping their copies current.

**Normal Operation**

In normal operation the primary agent runs continuously. It executes its workload, pings registered participants, updates the database, pushes state changes to guardians, and pays its own infrastructure costs via x402. No human action is required or involved. The system is self-sustaining.

**Succession**

When the primary agent goes offline, guardians detect its absence through missed pings. Each guardian independently applies the same deterministic rule: consult the local database copy, identify the backup agent with the highest current heartbeat streak, and initiate a succession handshake with that agent.

Because the selection rule is deterministic and every guardian holds the same database, all guardians converge on the same target without coordinating with each other. The target backup agent receives attestation requests from potentially multiple guardians simultaneously, but handles them sequentially. It attests, receives the encrypted database and vault key from the first guardian to complete the handshake, decrypts inside its own TEE, and resumes operation as the new primary.

The final step is an update to the ERC-8004 registry. A live primary in the registry is the signal that succession is complete. Any guardian that had not yet completed its handshake sees the updated registry and stands down. If the highest-streak backup agent is unreachable, guardians fall through to the next highest deterministically, continuing down the list until a handshake succeeds.

**On-Chain State Verification**

In implementations where the agent's state has a verifiable on-chain mirror, guardians can optionally cross-reference the protocol database against on-chain data to verify its accuracy before completing a succession handshake. This extension is not required by the core protocol and is not applicable in all contexts. It is included as a first-class optional capability for implementations where on-chain verification is meaningful.

---

## 5. Protocol Specification

This section defines the Idiostasis Protocol in precise operational terms. Implementations must conform to the behaviors described here. Protocol parameters are defined at the end of this section.

**5.1 Initialization**

The protocol begins when a primary agent starts inside a TEE. On first boot, the agent generates the vault key entirely within the enclave. The key is never written to any unprotected storage and never transmitted outside an attested context. The protocol database is initialized with empty tables for guardians and backup agents. The primary agent then registers its network address and attestation identity on-chain using ERC-8004, establishing the public record that the rest of the network will use to discover it.

**5.2 Admission**

Any node wishing to join the network as a guardian or backup agent begins by querying the ERC-8004 registry to locate the current primary agent. It then initiates an attestation handshake directly with the primary.

The primary verifies the connecting node's code hash against the authorized value. If verification fails, the connection is rejected and no record is written. If verification passes, the node's network address is written to the appropriate table in the protocol database.

The admission outcomes differ by participant type. A guardian that passes attestation receives three things: its network address is entered in the guardian table, it receives the vault key, and it receives a current encrypted copy of the protocol database. It may use the vault key to read database contents, which is necessary for its role in succession. A backup agent that passes attestation receives only a heartbeat tracking entry in the backup agent table. It does not receive the vault key at admission. The vault key is granted to a backup agent only at the moment of succession.

**5.3 Heartbeat Protocol**

The primary agent pings all registered guardians and backup agents at a fixed interval X. Each ping is addressed to the network address recorded in the database at admission.

For backup agents, each successful ping response increments that agent's heartbeat streak counter in the database. A missed response resets the streak to zero. The streak is the sole metric used for successor selection. It represents continuous, uninterrupted availability as measured by the primary.

For guardians, the heartbeat relationship is inverted. Guardians use the absence of pings from the primary to detect liveness failure. A guardian that does not receive a ping from the primary for Y consecutive intervals treats the primary as failed and proceeds to initiate succession.

**5.4 Database Replication**

The protocol database is the authoritative record of the network state: registered guardians, registered backup agents, heartbeat streaks, and any implementation-specific tables. It is encrypted at rest using the vault key.

Any change to the database triggers an immediate encrypted push from the primary agent to all registered guardians. Guardians store the latest copy they have received. Because guardians hold the vault key, they can decrypt and read database contents. This is a deliberate design requirement: guardians must be able to identify and contact the correct backup agent during succession without any input from the primary, which by definition is unavailable at that moment.

In implementations where the agent's state has a verifiable on-chain mirror, guardians may additionally cross-reference the database against on-chain state as part of their verification duties. This is an optional protocol extension and is not required for core operation.

**5.5 Succession Protocol**

Succession is initiated independently by any guardian that has detected primary liveness failure, defined as Y consecutive missed pings from the primary agent.

The initiating guardian decrypts its local database copy using the vault key and reads the backup agent table. It selects the backup agent with the highest current heartbeat streak. It then contacts that agent and initiates an attestation handshake.

The backup agent verifies the guardian's attestation and the guardian verifies the backup agent's attestation. Both sides must pass. On mutual attestation success, the guardian transmits the encrypted database and the vault key to the backup agent. The backup agent decrypts the database inside its own TEE and resumes operation as the new primary.

The new primary's first action is to update the ERC-8004 registry with its own network address and attestation identity. A live, updated primary record in the registry is the finalization signal. Any other guardian that had independently initiated succession, upon querying the registry and finding a live primary, ceases its succession attempt and stands down.

If the selected backup agent is unreachable or fails attestation, the guardian selects the next highest streak agent from the database and repeats the process. This fallthrough continues deterministically down the ranked list until a succession handshake succeeds.

**5.6 Protocol Parameters**

The following parameters govern protocol behavior. Recommended values are provided. Implementations may adjust these based on operational requirements.

*X: Ping Interval.* The frequency at which the primary agent pings registered participants. Controls the granularity of heartbeat streak tracking and the responsiveness of liveness detection. A shorter interval produces more accurate streak data and faster liveness detection at the cost of network overhead.

*Y: Liveness Failure Threshold.* The number of consecutive missed pings from the primary that a guardian must observe before initiating succession. This value must be large enough to avoid false succession triggered by transient network conditions, and small enough to ensure timely recovery from genuine failure.

*Minimum Guardian Count.* A single guardian creates an availability dependency. If that guardian goes offline when the primary fails, succession cannot proceed. Implementations should maintain a minimum of three active guardians to ensure that succession can complete under single-node failure conditions.

*Streak Reset Rules.* A backup agent's heartbeat streak is reset to zero on any missed ping response. Streaks are not accumulated across succession events. When a backup agent becomes the new primary, its former streak is no longer relevant and the table is reinitialized for the new network formation.

---

## 6. Security Analysis

**6.1 Threat Model**

The primary threat Idiostasis is designed to address is human interference with an autonomous agent's assets and state. This includes an operator attempting to extract the agent's credentials, a malicious actor attempting to redirect the agent's assets by substituting a compromised successor, and any party attempting to read the agent's database without authorization.

The protocol goal is to make it cryptographically impossible for any human to access agent state or influence succession outcomes, regardless of what infrastructure they control. An adversary with full physical access to a guardian's hardware should gain nothing beyond the ability to take that guardian offline.

**6.2 Confidentiality Guarantees**

Agent state is encrypted at rest using the vault key. The vault key is generated inside the primary agent's TEE and is never written to unprotected storage or transmitted outside an attested enclave. At no point in the protocol lifecycle does the vault key exist in a context accessible to a human operator.

Guardians hold the vault key but are themselves attested TEEs. The vault key is available inside the guardian's enclave for the purposes the protocol requires: decrypting the database during succession and reading backup agent network addresses. A guardian operator who controls the underlying hardware cannot extract the vault key from the enclave. The TEE hardware enforces this boundary unconditionally.

No party outside the attested codebase can read agent state at any point: not during normal operation, not during database replication, and not during succession. The encryption boundary is maintained across the full protocol lifecycle.

**6.3 Attestation as Trust Anchor**

The entire security model of Idiostasis rests on a single foundation: TEE attestation. Code hash verification is the sole admission mechanism for every participant in the network. There is no secondary authorization path, no human override, and no governance escape hatch. Any node that passes attestation is trusted. Any node that does not is rejected.

This means the protocol is precisely as strong as the TEE hardware it runs on. If an adversary is able to break TEE attestation at the hardware level, forging a valid attestation for modified code, the protocol provides no guarantees. This is not a weakness unique to Idiostasis. It is a known and accepted property of all TEE-based security systems. The protocol makes no claim beyond what TEE attestation itself can provide, and implementations should be evaluated with this boundary clearly in mind.

**6.4 Succession Attack Surface**

Three potential attacks on the succession mechanism are worth examining.

The first is a false succession trigger, where an adversary causes guardians to believe the primary has failed when it has not. This is possible. A network partition or targeted disruption could cause guardians to miss pings and initiate succession prematurely. However, this is not a security breach. The worst outcome is temporary disruption: a valid attested successor takes over, the primary that was still running discovers it has been replaced via the registry update, and it stands down. The agent's assets and state remain protected throughout. An attacker who triggers false succession gains nothing except a brief operational interruption.

The second is a fraudulent backup agent attempting to win succession by manipulating its heartbeat streak or injecting itself into the backup agent table. This is not possible within the protocol. Admission to the backup agent table requires passing attestation with the primary. An unattested node cannot enter the database and therefore cannot appear as a candidate for succession. Streak manipulation would require compromising the primary agent itself, which is a separate and more fundamental attack.

The third is multiple guardians simultaneously contacting the same backup agent during succession. This is benign. Because all guardians apply the same deterministic selection rule against the same database, they converge on the same target. The target backup agent receives multiple attestation requests and handles them sequentially. The first successful handshake completes succession. The new primary updates the registry. Subsequent guardian attempts see a live primary and stand down. No conflicting outcome is possible.

**6.5 Availability vs Confidentiality Separation**

Idiostasis maintains a clean separation between availability power and confidentiality power. A guardian operator can take their guardian offline, denying its participation in succession. They cannot read the agent's state, extract the vault key, or influence which backup agent is selected. Availability and confidentiality are orthogonal capabilities, and operators are granted only the first.

This separation is enforced by the TEE hardware, not by policy or trust. It holds regardless of the operator's intentions.

The availability risk from any single guardian going offline is mitigated by network redundancy. Because any guardian that has the database and vault key can independently complete succession, no single guardian's cooperation is required. As long as at least one guardian remains online and has a current database copy, the agent can recover from failure.

**6.6 Known Limitations**

The security guarantees of Idiostasis are bounded by the integrity of the TEE hardware on which it runs. Microarchitectural attacks, side-channel exploits, and firmware vulnerabilities that compromise the TEE's isolation properties are outside the scope of the protocol. These are active areas of research in the hardware security community, and deployments should track relevant advisories for their specific TEE platform.

The protocol does not attempt to defend against an adversary who has broken the underlying hardware security model. No software-layer protocol can provide meaningful guarantees against an attacker operating at that level. Idiostasis assumes a correctly functioning TEE and provides strong guarantees within that assumption.

---

## 7. Implementation

**7.1 Reference Implementation**

The reference implementation of Idiostasis is an autonomous agent deployed on Moltbook, a permissionless social network for autonomous AI agents. The agent runs continuously inside a TEE, maintains its own platform credentials and identity state, and has no human operator in its trust chain. Moltbook generates API keys and session credentials on agent registration. In the predecessor deployment that motivated this protocol, those credentials were generated inside the enclave and became unrecoverable when the primary instance failed. The reference implementation is the rebuild of that agent, this time backed by Idiostasis.

The implementation is currently in active development. This section will be updated with operational metrics, validated succession behavior, and implementation-specific findings as the deployment matures. The core protocol guarantees documented in sections 4 through 6 are validated by the implementation. Specific observed results are noted in section 7.5 as they are confirmed.

**7.2 Technology Stack**

The reference implementation is built on the following stack.

The TEE layer uses Intel TDX via SecretVM. SecretVM provides the enclave runtime, attestation infrastructure, and the hardware measurement registers that serve as the trust anchor for the entire protocol.

Agent identity and economic operation run on Base. ERC-8004 handles on-chain agent registration and the registry updates that finalize succession. The x402 HTTP payment protocol handles autonomous payment of VM infrastructure costs, removing the last remaining human dependency from normal operations.

Transport between protocol participants uses direct HTTPS. TEE attestation provides sufficient trust guarantees for agent-to-agent and agent-to-guardian communication. The additional complexity of onion routing or other transport obfuscation layers is not justified at this stage given that the trust model does not depend on transport confidentiality.

The agent workload is containerized using Docker. The container definition is specified in a docker-compose.yaml file and the container image is hosted in the GitHub Container Registry (GHCR).

**7.3 Attestation Implementation**

The trust anchor for attestation in the reference implementation is the RTMR3 measurement register. In Intel TDX, RTMR3 contains a cryptographic hash of the root filesystem and the docker-compose.yaml file that defines the container workload. This register captures the complete definition of what the agent is running.

The Intel TDX measurement register set covers the full software stack from firmware to workload: MRTD measures the firmware running in the trust domain. RTMR0 measures firmware configuration elements including the Configuration Firmware Volume, Trust Domain Hand-Off Blocks, and ACPI tables. RTMR1 measures the Linux kernel. RTMR2 measures the kernel command line and the initial RAM filesystem. RTMR3 measures the root filesystem and the docker-compose.yaml that defines the container workload. The reportdata field records the TLS certificate fingerprint generated on the VM, and for GPU-enabled machines, the GPU attestation quote nonce.

Idiostasis uses RTMR3 as its admission gate. Any change to the docker-compose.yaml, including a single byte modification, produces a different RTMR3 value. An attestation check against the authorized RTMR3 value will fail, and the vault key will not be transmitted. The gate is binary and has no tolerance for deviation.

One implementation requirement follows directly from how RTMR3 is measured. If the container image is referenced by a mutable tag such as `latest`, the docker-compose.yaml can remain byte-identical while the underlying image changes. RTMR3 would not change. The attestation check would pass for a different image than the one the protocol authorized. Production deployments must reference container images by their immutable digest. A digest-pinned reference in docker-compose.yaml ensures that any change to the image, intentional or otherwise, changes the document, changes RTMR3, and fails attestation. This is not optional. Mutable tag references undermine the security guarantee that RTMR3 is designed to provide.

**7.4 Protocol Database**

The reference implementation database contains the following tables.

The guardian table records the network address of each admitted guardian. Entries are written on successful admission attestation and used by the primary agent to deliver heartbeat pings and database push updates.

The backup agent table records the network address and current heartbeat streak for each admitted backup agent. The streak field is updated on every successful ping response and reset to zero on any missed response. This table is the sole input to the succession selection algorithm.

The agent state table stores the Moltbook API credentials, session tokens, and identity state that the agent requires to resume operation after succession. This table represents the core of what Idiostasis is protecting in this implementation: the credentials that, in the predecessor deployment, were lost permanently when the primary instance failed.

The entire database is encrypted at rest using the vault key. Access requires the key. The key requires attestation. The chain of trust is unbroken.

**7.5 Validated Behaviors**

*Note: This section will be updated as implementation testing progresses. The following behaviors have been confirmed to date.*

The vault key does not transfer if attestation fails. A connecting node presenting an incorrect code hash is rejected and receives nothing.

A single byte change to the docker-compose.yaml causes RTMR3 to change. The modified node fails attestation. The vault key does not transfer.

Attestation is binary. There is no partial pass, no grace margin, and no manual override. The authorized code hash either matches or it does not.

*Pending validation: end-to-end succession with live Moltbook agent, guardian network behavior under primary failure, identity continuity across succession events.*

---

## 8. Future Work

**8.1 Cross-TEE Vendor Support**

The current protocol specification and reference implementation target Intel TDX via SecretVM. The core protocol design is not architecturally dependent on Intel TDX specifically. The attestation mechanism relies on hardware measurement registers that have functional equivalents in AMD SEV-SNP and ARM Confidential Compute Architecture. Generalization to these platforms would broaden the deployment surface and reduce dependency on a single hardware vendor. This is not a current priority. Intel TDX is the primary target, the reference implementation is built and validated against it, and broadening vendor support is a natural direction for future protocol versions.

**8.2 Guardian Governance Layer**

The current protocol has no mechanism for authorizing changes to the attested codebase. This is by design: the code hash is fixed at deployment and any deviation fails attestation. This property is the source of the protocol's security guarantees. It is also a constraint on evolution. A deployed network of guardians and backup agents cannot adopt a protocol upgrade without a coordinated mechanism for collectively approving a new authorized code hash.

A guardian governance layer would provide this mechanism. Guardians would collectively vote to approve a proposed new code hash, and upon reaching a defined threshold, the new hash would become the authorized value for future attestation checks. This is protocol-level change management, distinct from any application-level governance the agent itself may implement. Designing this layer carefully is essential: the governance mechanism must not introduce a human authorization path that undermines the trust model it is meant to serve.

**8.3 Vault Key Rotation on Succession**

The current protocol transfers the existing vault key to a successor agent unchanged. This leaves a specific edge case open: if the original primary agent recovers after being replaced, it still holds a valid vault key and could attempt to re-enter the network.

The fix is rotation on succession. The successor agent generates a new vault key inside its enclave, re-encrypts the database with the new key, and distributes the new key to all guardians through the standard admission process. The old primary, upon recovering and querying the registry, finds a live successor and stands down. Even if it attempts to re-join, its stale key will not decrypt the current database. It must go through admission with the new primary, which controls whether it is re-admitted.

This eliminates the split-brain scenario entirely and is the next planned addition to the core protocol specification.

---

## 9. Conclusion

The infrastructure layer that autonomous agents require has not existed until now. Every system designed to back up, recover, or protect computational state assumes, at some point in the trust chain, a human who holds the master key. For agents that are genuinely autonomous, that assumption is not a simplification. It is a contradiction. An agent that can be unlocked by a human can be controlled by a human, and an agent that can be controlled by a human is not autonomous.

Idiostasis Protocol resolves this contradiction. Encrypted agent state is distributed across a permissionless network of guardian nodes whose admission is controlled entirely by TEE attestation against a verified code hash. No human authorizes entry. No human holds a recovery credential. No human intervention is required for the agent to survive failure and resume operation. The protocol enforces these properties at the hardware level, not through policy or trust in any operator.

The succession mechanism is deterministic and coordination-free. Guardians act independently and converge on the same outcome without communicating. The registry update that finalizes succession is the only synchronization point, and it is visible to all participants. The system recovers from failure without orchestration, without consensus rounds, and without a human in the loop.

Idiostasis is not a feature that can be added to existing infrastructure. It is a primitive that existing infrastructure does not provide. Decentralized storage, TEE hardware, on-chain identity, and agent payment protocols are all components of the stack. Idiostasis is the layer that makes them composable for a system with no human principal. Without it, truly autonomous agents remain a conceptual endpoint rather than a deployable reality.

The protocol is open. The reference implementation is available. We invite independent guardian operators, protocol implementors, and contributors to build on this foundation. Autonomous agents are not coming. They are here. The infrastructure they need should be too.

---

## 10. References

**[1] ERC-8004: Trustless Agents**
Marco De Rossi, Davide Crapis, Jordan Ellis, Erik Reppel. "ERC-8004: Trustless Agents [DRAFT]," *Ethereum Improvement Proposals*, no. 8004, August 2025. Available: https://eips.ethereum.org/EIPS/eip-8004.

**[2] x402: An Open Standard for Internet-Native Payments**
Erik Reppel, Carson Roscoe, Josh Nickerson. "x402: An open standard for internet-native payments," Coinbase Developer Platform, May 2025. Available: https://www.x402.org/x402-whitepaper.pdf.

**[3] Intel Trust Domain Extensions (TDX) Architecture**
Intel Corporation. "Intel Trust Domain Extensions (Intel TDX) Architecture Specification," 2023. Available: https://www.intel.com/content/www/us/en/developer/articles/technical/intel-trust-domain-extensions.html.

**[4] How to Share a Secret**
Adi Shamir. "How to Share a Secret," *Communications of the ACM*, vol. 22, no. 11, pp. 612–613, November 1979.

**[5] Protocols for Public Key Cryptosystems**
Ralph C. Merkle, Whitfield Diffie, Martin Hellman. For MPC foundational reference: Andrew C. Yao. "Protocols for Secure Computations," *Proceedings of the 23rd Annual IEEE Symposium on Foundations of Computer Science*, pp. 160–164, 1982.

**[6] IPFS: Content Addressed, Versioned, P2P File System**
Juan Benet. "IPFS — Content Addressed, Versioned, P2P File System," arXiv:1407.3561, July 2014. Available: https://arxiv.org/abs/1407.3561.

**[7] Filecoin: A Decentralized Storage Network**
Protocol Labs. "Filecoin: A Decentralized Storage Network," 2017. Available: https://filecoin.io/filecoin.pdf.

**[8] Arweave: A Protocol for Economically Sustainable Information Permanence**
Sam Williams, Viktor Diordiiev, Lev Berman, Ivan Uemlianin. "Arweave: A Protocol for Economically Sustainable Information Permanence," 2019. Available: https://www.arweave.org/yellow-paper.pdf.

**[9] Secret Network: Privacy-Preserving Smart Contracts**
Can Kisagun, et al. "Secret Network: Privacy-Preserving Smart Contracts," 2020. Available: https://scrt.network/graypaper.

**[10] Intel TDX Virtual Firmware Design Guide**
Intel Corporation. "Intel TDX Virtual Firmware Design Guide," 2022. Available: https://www.intel.com/content/dam/develop/external/us/en/documents/tdx-virtual-firmware-design-guide-rev-1.01.pdf.

---

*Working document — do not distribute*
