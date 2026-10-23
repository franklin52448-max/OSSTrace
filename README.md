# OSSTrace

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
| Wallet sign-in (Phantom/MetaMask — a user is a `(chain, walletAddress)` pair, challenge/verify flow, no password anywhere — `packages/server/src/auth/wallet.ts`) + connect/settings UI in the web header | **Active**. *Supersedes* the email+password accounts system (ADR 0006) this table used to list here: that system, and the `user`/`moderator`/`admin` role tiers it introduced, were built and then fully removed in favor of wallet auth. ADR 0006 is kept as a historical record, not current design. |
| Private labels — label any address for yourself only, never shown to anyone else, no source needed ([ADR 0004](docs/adr/0004-label-trust-tiers-and-private-labels.md), [`packages/features/private-labels`](packages/features/private-labels/README.md)) | **Active** (no "share as Community label" yet) |
| Visualizer (`GET /graph/:chain/:address` + interactive graph in the web UI) — **v1 is one hop**: the address and its direct counterparties only, draws both native and decoded ERC-20/SPL token transfers, and reports a reverted transaction as its own `"failed"` reason instead of lumping it in with genuinely undecodable activity | **Active** |
| Label trust tiers ([ADR 0004](docs/adr/0004-label-trust-tiers-and-private-labels.md), [ADR 0007](docs/adr/0007-community-label-submissions-and-review.md)): logged-in users submit sourced **Community** labels | **Removed.** The Confirmed-tier moderation workflow (a moderator reviewing and confirming a Community label, with a web UI Moderation tab) was built, then deleted along with the `moderator` role itself when auth moved to wallets — there's no replacement moderation concept today. Community-tier submission without review may still exist in the old `packages/features/community-labels/` code; confirm against that package's own README before relying on this row. |
| Tracer (`GET /trace/graph` + `GET /trace/path` — multi-hop fund tracing, ETH + Solana, up to 3 hops, filterable by token/amount/time — [ADR 0008](docs/adr/0008-tracer-multi-hop-search-design.md), [`packages/features/tracer`](packages/features/tracer/README.md)) | **Active** |
| Tracer cross-chain bridge hops (`?bridges=wormhole`): follows a real Wormhole transfer between Ethereum and Solana as a `kind: "bridge"` edge with both chains' real tx hashes, and keeps tracing on the other chain ([ADR 0012](docs/adr/0012-tracer-cross-chain-bridge-hops-via-wormhole.md)) | **Active** (Wormhole only. The cross-chain link comes from Wormholescan's public index and isn't re-checked on the destination chain yet. Transfers to other chains or with no indexed destination tx are reported as dead ends, not followed) |
| Risk scoring (`GET /risk/:chain/:address` + a "Risk score" card on the Lookup report — [ADR 0010](docs/adr/0010-risk-scoring-model.md), [`packages/features/risk-scoring`](packages/features/risk-scoring/README.md)): 0–100 from a real risk tag on the address itself (100) or the nearest risk-tagged address within 1–3 hops via Tracer (75/50/25); an unfinished search is reported `inconclusive`, never `none` | **Active** (only risk source today is the ingested `sanctioned` tag; single-chain, address-level only, no entity scores) |
| Case management — group real addresses, each with your own note, into an owned open/closed investigation record, **private to its owner only** (no sharing, no admin read path — [ADR 0011](docs/adr/0011-case-management-private-owner-only-cases.md), [`packages/features/case-management`](packages/features/case-management/README.md)); API + web UI Cases tab | **Active** (no sharing; no "add to case" button from Lookup/Graph yet) |
| Real-time streaming (`ws://…/stream` on the Explorer — [ADR 0013](docs/adr/0013-real-time-streaming-rides-the-indexer.md)): subscribe to an address, get pushed each real new transaction the background indexer's regular refetch finds; zero extra RPC calls. Live "LIVE / Not live" badge + pushed rows in the web UI's Lookup view | **Active** (only addresses in the indexer's top-N most-looked-up set get pushes — any other subscription is told `not_indexed`; lag up to one indexer interval, default 30s; needs the indexer running, via shared `REDIS_URL` or `EXPLORER_EMBEDDED_INDEXER=1`) |
| More chains (Bitcoin, Tron, etc.) | Not built — see [Adding a chain](packages/chains/README.md) |
| AI agent for natural-language on-chain questions ("has wallet A sent wallet B more than $100 of USDC in the last 30 days?"), backed by Tracer's real traversal, never a guessed answer | Not built — see "Bounties" below |
| Bounty board (`GET`/`POST /api/bounties` on the unified server — `packages/server/src/routes/bounties.ts`, [ADR 0009](docs/adr/0009-bounty-program-v1-is-tracking-only.md) — moved here from the old standalone `packages/features/bounties`, which is deleted), web UI Bounties tab: anyone opens a bounty with a spec + their own stated reward, anyone submits a PR against it, **the bounty's own opener** resolves/claims/cancels it | **Active** (tracks the workflow only — never holds or moves the reward; see "Bounties" below). *Resolution rule changed from the original design*: there's no `moderator` role anymore (see the auth row above), so this is now the opener's own call, not a moderator's — the simplest rule that still matched ADR 0009's intent. |
| Site theming — dark/light toggle plus a full "Customize theme" panel that retints every surface live, built from one token list a fork can extend ([ADR 0021](docs/adr/0021-site-theming-dark-light-and-per-token-customization.md), [`packages/web`](packages/web/README.md#theming)) | **Active** (per-browser via `localStorage`, no account sync yet) |

**The honest pitch today**: a real, working address-lookup tool across Ethereum and Solana, with a
small, genuinely-sourced seed labelset, real multi-hop tracing, sanctions-exposure risk scoring,
private investigation cases, a live bounty board, and an architecture built so a new chain or a new
feature can be
added as a self-contained module without touching the core. Everything past the table above is
unbuilt — tracked honestly, not hidden.

## Bounties

**Live**, now on the unified server (`packages/server/src/routes/bounties.ts`) — the Bounties tab
in the web UI is unchanged, only the backend moved. The idea: a feature doesn't have to come from
someone who can code it. Anyone — technical or not — opens a bounty: write up the feature in depth
(what it does, how it should behave, what "done" looks like), state your own reward offer in your
own words, and it goes on the public board. Anyone submits a PR against it; the bounty's own
**opener** records which submission wins (not a moderator — that role doesn't exist anymore, see
the status table above).

**What it does *not* do — on purpose:** hold, escrow, or move any funds. A bounty's reward is
free text exactly as the poster wrote it ("100,000 tokens", "$500, token TBD"), never parsed as a
real currency amount. The actual payout happens off-platform, between the bounty's opener and
whoever they themselves mark as the winning submission. See
[ADR 0009](docs/adr/0009-bounty-program-v1-is-tracking-only.md) for why: a real token-escrow
system would be custody, which conflicts with this project's own non-goal of staying read-only /
non-custodial — so v1 ships the real, honest part (the board and its workflow) without pretending
to be a bank it isn't.

**The first bounty posted** is an AI agent that answers real on-chain questions in plain language
by actually calling this project's own tools, not by guessing:

> "Is wallet A connected to wallet B?" / "Did wallet A send wallet B more than $100 in USDC within
> the last 30 days?"

The agent would use **Tracer**'s `tracePath` (now built — see the table above) to check the real
transaction graph and answer with a real, checkable result.

## Why the architecture looks like this

This project is explicitly designed so a random contributor — human or an AI coding agent — can
open one folder, read its `README.md`, and start contributing without reading the whole codebase
first. Three rules make that true:

1. **Chains are plugins.** Every chain lives in its own folder under `packages/chains/<chain>/`
   implementing one interface (`ChainAdapter` in `packages/core`). Adding a chain never requires
   touching core or any other chain.
2. **Features are plugins.** Every feature (Explorer, Visualizer, Tracer, Risk Scoring today; Case Management later)
   lives in its own folder under `packages/features/<feature>/`, consuming the core data model and
   chain adapters, never reaching into another feature's internals.
3. **Every folder explains itself.** Every package has its own `README.md` stating what it is, how
   it plugs into the rest, and how to extend it. Durable architectural decisions live in
   [`docs/adr/`](docs/adr/) instead of being buried in chat history or someone's memory.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full picture and
[`CONTRIBUTING.md`](CONTRIBUTING.md) for how to add something.

## Try it

Node 24+.

The site the live frontend actually talks to is one unified server (`packages/server`, ADR 0022) —
not the list of separate per-feature services this section used to describe (those scripts still
exist and still run their own old standalone code, but the real site doesn't use them):

```sh
npm install
cp .env.example .env   # works with zero config; see the file for what each var does
npm run ingest:ofac    # pulls the real OFAC SDN list and builds the seed labelset
npm run ingest:uk      # same for the UK Sanctions List
npm run ingest:safe    # Safe's official deployment list (Ethereum mainnet contracts)
npm run check          # typecheck + tests
npm run dev:server     # starts the unified server packages/web actually talks to (packages/server/README.md)
npm run dev:web        # starts the web UI, in another terminal
```

Set `DEV_SKIP_AUTH=1` on `dev:server` to exercise every feature without going through a real
Phantom/MetaMask wallet connection (refused outright if `NODE_ENV=production`, so it can never
activate on a deployed instance — see `packages/server/README.md`). Solana needs no API key for
balances/history; Ethereum reads from Blockscout's public API, also no key needed.

## License

[AGPL-3.0-only](LICENSE) — chosen specifically so a hosted fork of this project must also stay
open source. See [ADR 0003](docs/adr/0003-license-choice.md) for why.

## Status

Live and public: github.com/OpenTraceIntelligence/OSSTrace, deployed to osstrace.com and
opensourcetrace.org. Started as a real, working vertical slice, not a mockup, with a lot of the
product surface (Case Management, cross-chain tracing, more chains) still to build — that's still
true. The auth model has since changed from the originally-planned email/password accounts system
to wallet sign-in (Phantom/MetaMask), and the label-moderation workflow built alongside the
original accounts system was removed along with it; see the status table above for what's current.

## More context

[`PRD.md`](PRD.md) — the full product requirements doc (goals, scope, feature inventory, open
questions). [`ROADMAP.md`](ROADMAP.md) — the set, phased task list for what gets built next.
[`LORE.md`](LORE.md) — the positioning/narrative doc: why this exists, what it
deliberately isn't, and what it's trying to become.
