# OpenTraceIntelligence

An open-source, multi-chain on-chain intelligence platform: look up an address or entity, see its
balance and transaction history, and see any **genuinely sourced** label or tag attached to it.

This project exists because the leading tools in this space (Arkham and similar) are closed,
proprietary platforms. Nothing here is a copy of any specific product, its name, its branding, or
its data — it's an independent, from-scratch build of the same *idea*: on-chain transparency
tooling, open for anyone to run, audit, or extend.

## The goal

**Build and keep public, forever, the largest openly-licensed labeled wallet/entity database that
exists** — every entry real, every entry sourced, free for anyone to use without asking
permission. That's not a feature of this project, it's the point of it. See
[ADR 0005](docs/adr/0005-public-labeled-database-is-the-goal.md) for where that data is allowed to
come from (and the one place it explicitly never comes from).

## The two rules everything else follows

**1. A label without a cited, public source is not a label — it's a guess, and it doesn't go in.**
Every entry in the label dataset carries a `source` field (a URL or a named public document) and
a `addedAt` date. There is no "trust us" data in this project. See
[`data/labels/README.md`](data/labels/README.md).

**2. This project's primary design goal is that outside contributors — human or an AI coding
agent — can extend it without reading the whole codebase first.** Not a nice-to-have, the main
thing: every architectural choice here (chains and features as self-contained plugins, a README
in every folder, ADRs instead of tribal knowledge) exists to serve this. If a change would make
the project faster to extend but structurally messier, that tradeoff is usually worth taking. If
a change would make one feature slightly more convenient at the cost of making the architecture
harder for the next contributor to understand, it probably isn't. See
[`ARCHITECTURE.md`](ARCHITECTURE.md) and [`FEATURE_GUIDELINES.md`](FEATURE_GUIDELINES.md).

## What exists today

| Feature | Status |
|---|:---:|
| Core data model (Address / Entity / Label / Tag / Source) | **Active** |
| `ChainAdapter` plugin interface | **Active** |
| Ethereum chain adapter (balance via public RPC; tx history needs a free Etherscan API key) | **Active** |
| Ethereum ERC-20 token transfer decoding (Etherscan `tokentx`, real decimals, merged per tx) | **Active** |
| Solana chain adapter (balance + tx history via public RPC, no key needed) | **Active** |
| Solana SPL token transfer decoding (`transfer`/`transferChecked`, incl. Token-2022) | **Active** |
| Explorer API (`GET /address/:chain/:address` — balance, recent txs, label, tags; cached per address + `?limit=`) | **Active** |
| Caching + a background indexer (real Redis-backed, keeps popular addresses instant) | **Active** |
| Minimal web UI (paste an address, see what we know) | **Active** |
| Seed labelset: sanctioned digital-currency addresses (US OFAC SDN + UK Sanctions List) and Safe's official protocol contracts | **Active** |
| Accounts API (signup/login/sessions, `user`/`moderator`/`admin` roles — [ADR 0006](docs/adr/0006-accounts-and-auth.md)) + log-in/sign-up form in the web UI | **Active** (no email verification or rate limiting yet) |
| Private labels — label any address for yourself only, never shown to anyone else, no source needed ([ADR 0004](docs/adr/0004-label-trust-tiers-and-private-labels.md), [`packages/features/private-labels`](packages/features/private-labels/README.md)) | **Active** (no "share as Community label" yet) |
| Visualizer (`GET /graph/:chain/:address` + interactive graph in the web UI) — **v1 is one hop**: the address and its direct counterparties only, native-token transfers only | **Active** |
| Label trust tiers (Confirmed) ([ADR 0004](docs/adr/0004-label-trust-tiers-and-private-labels.md)) | Not built (unblocked by accounts) |
| Tracer (hop-by-hop fund tracing across chains/bridges) | Not built |
| Risk scoring | Not built |
| Case management | Not built |
| Real-time streaming (websocket) | Not built |
| More chains (Bitcoin, Tron, etc.) | Not built — see [Adding a chain](packages/chains/README.md) |

**The honest pitch today**: a real, working address-lookup tool across Ethereum and Solana, with a
small, genuinely-sourced seed labelset and an architecture built so a new chain or a new feature
(Tracer, Risk Scoring, ...) can be added as a self-contained module without touching
the core. Everything past the table above is unbuilt — tracked honestly, not hidden.

## Why the architecture looks like this

This project is explicitly designed so a random contributor — human or an AI coding agent — can
open one folder, read its `README.md`, and start contributing without reading the whole codebase
first. Three rules make that true:

1. **Chains are plugins.** Every chain lives in its own folder under `packages/chains/<chain>/`
   implementing one interface (`ChainAdapter` in `packages/core`). Adding a chain never requires
   touching core or any other chain.
2. **Features are plugins.** Every feature (Explorer and Visualizer today; Tracer/Risk Scoring later)
   lives in its own folder under `packages/features/<feature>/`, consuming the core data model and
   chain adapters, never reaching into another feature's internals.
3. **Every folder explains itself.** Every package has its own `README.md` stating what it is, how
   it plugs into the rest, and how to extend it. Durable architectural decisions live in
   [`docs/adr/`](docs/adr/) instead of being buried in chat history or someone's memory.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full picture and
[`CONTRIBUTING.md`](CONTRIBUTING.md) for how to add something.

## Try it

Node 24+.

```sh
npm install
cp .env.example .env   # add ETHERSCAN_API_KEY (free, from etherscan.io/apis) for Ethereum tx history
npm run ingest:ofac    # pulls the real OFAC SDN list and builds the seed labelset
npm run ingest:uk      # same for the UK Sanctions List
npm run ingest:safe    # Safe's official deployment list (Ethereum mainnet contracts)
npm run check          # typecheck + tests
npm run dev:explorer   # starts the Explorer API
npm run dev:visualizer # starts the Visualizer (graph) API, in another terminal
npm run dev:web        # starts the web UI, in another terminal
npm run dev:accounts   # optional: the accounts API (see packages/features/accounts/README.md)
npm run dev:private-labels # optional, with dev:accounts: your own private labels in the web UI
```

Without `ETHERSCAN_API_KEY`, the Ethereum adapter still returns a real balance (via public RPC)
but reports transaction history as unavailable rather than guessing or faking it. Solana needs no
key at all.

## License

[AGPL-3.0-only](LICENSE) — chosen specifically so a hosted fork of this project must also stay
open source. See [ADR 0003](docs/adr/0003-license-choice.md) for why.

## Status

Early, in development. Built in one focused session as a real, working vertical slice — not a
mockup — with a lot of the product surface (Tracer, Risk Scoring, more chains) still
to build. Contributions welcome once this has a public home.

## More context

[`PRD.md`](PRD.md) — the full product requirements doc (goals, scope, feature inventory, open
questions). [`ROADMAP.md`](ROADMAP.md) — the set, phased task list for what gets built next.
[`LORE.md`](LORE.md) — the positioning/narrative doc: why this exists, what it
deliberately isn't, and what it's trying to become.
