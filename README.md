# Idiostasis Protocol

On-chain agent identity registry with off-chain attestation management. Agents register cryptographic identities on an EVM registry contract and maintain local attestation state via SQLite.

## Directory Structure

```
src/
  agent/       — Agent runtime and lifecycle
  database/    — SQLite schema and queries
  registry/    — EVM registry client (viem)
  types/       — Shared TypeScript types
  vault/       — Key derivation and storage
  wallet/      — Wallet management
contracts/     — Foundry project (IdiostasisRegistry.sol)
scripts/       — Test utilities
tests/         — Vitest test suite
```

## Setup

```bash
npm install
cd contracts && forge install && cd ..
```

Copy `.env.example` to `.env` and fill in values.

## Build & Test

```bash
npm run build       # TypeScript → dist/
npm test            # Run vitest suite
cd contracts
forge build         # Compile Solidity
forge test          # Run Foundry tests
```

## Deploy Contract

```bash
cd contracts
forge script script/Deploy.s.sol --rpc-url $EVM_RPC_URL --private-key $DEPLOYER_KEY --broadcast
```

## Environment Variables

| Variable | Description |
|---|---|
| `DEPLOYER_KEY` | Deployer private key (0x-prefixed) |
| `REGISTRY_CONTRACT_ADDRESS` | Deployed registry contract address |
| `EVM_RPC_URL` | RPC endpoint (defaults to `https://sepolia.base.org`) |
