# ADR 0001 — Plugin architecture for chains and features

Status: Decided 2026-10-21

## Context

The founding goal of this project is that a random outside contributor (or an AI coding agent
working on its behalf) can add a new blockchain or a new feature without having to understand or
risk breaking the rest of the codebase.

Research into how existing on-chain intelligence platforms (Arkham's public docs/API) model their
own system was useful here, for two reasons:

1. Their core data model — Address / Entity / Label / Tag / Cluster / Counterparty, with Labels
   being 1-per-address and Entities grouping addresses across chains — is a proven shape worth
   reusing structurally, even though we have none of their actual data.
2. Their own supported-chain list has visibly churned over time (chains added, then later
   dropped — Polygon added, then Linea/Manta/Blast/TON removed in various rounds) even at a
   company with dedicated engineering resources. That's a strong signal that chain support is
   inherently a plugin surface, not something to hardcode into a core.

## Decision

1. `packages/core` owns only the shared data model and a `ChainAdapter` interface. It contains no
   chain-specific or feature-specific logic.
2. Every chain is a separate package under `packages/chains/<chain>/`, implementing
   `ChainAdapter`. Nothing outside that folder (plus one registry line) needs to change to add a
   chain.
3. Every feature (Explorer first; Visualizer/Tracer/Risk Scoring/Case Management later) is a
   separate package under `packages/features/<feature>/`, consuming `core` and the chain
   registry, never another feature's internals directly.
4. Every package carries its own `README.md`. There is no single mega-README a contributor has to
   read end to end before making a small change.

## Consequences

- Adding Bitcoin support later cannot accidentally break the Ethereum or Solana adapters — they
  don't share code paths beyond the typed interface.
- The `ChainAdapter` interface itself becomes the single place that's expensive to change — any
  edit to it ripples through every chain package. It should be extended conservatively (add
  optional methods, don't change existing method signatures without a clear migration note).
- This does mean some duplication across chain packages (each has its own HTTP/RPC client setup).
  That's an accepted tradeoff for isolation — see "What would change this decision" below.

## What would change this decision

If chain packages end up needing substantial shared plumbing (retry logic, rate limiting, caching)
duplicated across many of them, extract a shared `packages/chains/_shared` utility package rather
than putting it in `core` (keeps `core` chain-agnostic) or copy-pasting indefinitely.
