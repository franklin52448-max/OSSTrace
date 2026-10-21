# Architecture

## Goal

Someone — a human contributor or an AI coding agent — should be able to open this repo cold, read
a handful of short READMEs, and know exactly where to add a new chain, a new feature, or a new
label source, without reading the rest of the codebase first. Every structural decision below
exists to make that true.

## Layout

```
open-trace-intelligence/
├── packages/
│   ├── core/              shared types + the ChainAdapter interface + the label/entity store
│   ├── chains/
│   │   ├── ethereum/      implements ChainAdapter for Ethereum
│   │   └── solana/        implements ChainAdapter for Solana
│   ├── features/
│   │   ├── explorer/      the address/entity lookup API — consumes core + chains
│   │   └── accounts/      user accounts, sessions, roles (ADR 0006) — other features depend on it
│   └── web/                minimal React UI — consumes the Explorer API over HTTP
├── data/
│   └── labels/            seed label data, each entry sourced and dated
├── scripts/
│   ├── ingest-ofac-sdn.ts fetches the real OFAC SDN list, writes data/labels/ofac-sdn.json
│   ├── ingest-uk-sanctions.ts          UK Sanctions List → data/labels/uk-sanctions-list.json
│   └── ingest-safe-deployments.ts      Safe's official deployments → data/labels/safe-deployments.json
└── docs/adr/               durable architecture decisions and why they were made
```

## The core data model

Defined once, in `packages/core/src/types.ts`, and reused by every chain adapter and feature.
Deliberately mirrors the shape that on-chain intelligence tools converge on (this is a proven
shape, not an invention — see [ADR 0001](docs/adr/0001-plugin-architecture.md) for the research
this came from):

- **Address** — `{ chain, value }`. The base unit; always scoped to a specific chain.
- **Entity** — a real-world actor, holding a set of `Address`es that can span multiple chains.
- **Label** — at most one per address: a human-readable identity (`"Binance 14"`). Always carries
  a `Source`.
- **Tag** — independent of labeling; a behavior/category marker (`"sanctioned"`, `"exchange"`,
  `"mixer"`). An address can be tagged without being labeled. Always carries a `Source`.
- **Source** — `{ description, url, addedAt }`. Required on every Label and Tag. This is the
  mechanism, not a policy document, that keeps fabricated data out: there is no code path that
  inserts a Label or Tag without one.

## The `ChainAdapter` interface

One interface, defined in `packages/core/src/chainAdapter.ts`, that every chain package
implements:

```ts
interface ChainAdapter {
  readonly chain: ChainId;
  getBalance(address: string): Promise<Balance>;
  getRecentTransactions(address: string, limit: number): Promise<TransactionSummary[] | { unavailable: string }>;
}
```

`getRecentTransactions` returns a typed "unavailable" result (with a human-readable reason) rather
than throwing or returning an empty array when data genuinely can't be fetched (e.g. no API key
configured) — callers can tell "there are no transactions" apart from "we couldn't check."

### Adding a new chain

1. Create `packages/chains/<chain-name>/`.
2. Implement `ChainAdapter` against real data for that chain — no mocked responses.
3. Register it in `packages/features/explorer/src/registry.ts`.
4. Write a `README.md` in your chain folder: what RPC/API it talks to, what needs an API key (if
   anything), and what it can't do yet.

Nothing outside your folder and the one-line registry entry needs to change.

## The Explorer feature

`packages/features/explorer` is the first feature module. Given a chain + address, it:
1. Asks the matching `ChainAdapter` for balance + recent transactions.
2. Asks the core label store for any `Label`/`Entity`/`Tag` on that address.
3. Returns both together.

Every later feature (Visualizer, Tracer, Risk Scoring, Case Management) is meant to follow the
same shape: its own folder, consuming `core` + `chains`, never reaching into another feature's
internals.

## Why not one shared "god" backend file

A single backend file that branches on `if (chain === 'ethereum')` everywhere is exactly what
makes a codebase hard for a newcomer (or an agent) to extend safely — every change risks breaking
an unrelated chain. The plugin boundary (one folder per chain, one typed interface) means a
contributor adding Bitcoin support can't accidentally break Solana, and doesn't need to understand
Solana's code to do their work.

## What's explicitly not solved yet

See the status table in [`README.md`](README.md). Most importantly: this only covers two chains,
has a small seed labelset, and has no real-time layer — all deliberate scope cuts for a one-day
first build, not hidden limitations.
