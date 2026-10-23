# Architecture

## Goal

Someone — a human contributor or an AI coding agent — should be able to open this repo cold, read
a handful of short READMEs, and know exactly where to add a new chain, a new feature, or a new
label source, without reading the rest of the codebase first. Every structural decision below
exists to make that true.

## Layout

**Updated 2026-10-23 — this section described the architecture as originally planned (each feature
as its own standalone service). That's no longer what the live site runs on; see the note below
the tree.**

```
osstrace/
├── packages/
│   ├── core/              shared types + the ChainAdapter interface + the label/entity store
│   ├── chains/
│   │   ├── ethereum/      implements ChainAdapter for Ethereum
│   │   └── solana/        implements ChainAdapter for Solana
│   ├── contract/          @osstrace/contract — shared types/schemas between packages/server and
│   │                      packages/web (requests, responses, the Chain union, etc.)
│   ├── server/            @osstrace/server (ADR 0022) — the ONE backend packages/web actually
│   │                      talks to today: wallet sign-in (auth/wallet.ts), addresses/balances/
│   │                      transfers, alerts, labels, traces, bounties — all routes under
│   │                      routes/. Supersedes the standalone per-feature services below for
│   │                      everything the live site uses.
│   ├── features/
│   │   ├── explorer/      the ORIGINAL standalone address-lookup service. The live site's
│   │   │                  Explorer view now calls packages/server instead — this package may
│   │   │                  still exist on disk and/or have real test coverage; check its own
│   │   │                  README and this repo's current state before assuming it's dead code.
│   │   ├── accounts/      the ORIGINAL email+password accounts/roles service (ADR 0006).
│   │   │                  Replaced entirely by packages/server's wallet-based auth — nothing on
│   │   │                  the live site uses this anymore.
│   │   ├── private-labels/ ORIGINAL standalone private-labels service (ADR 0004) — consumed the
│   │   │                  old accounts service above. May still be test-covered; check current
│   │   │                  state before assuming dead.
│   │   ├── community-labels/  ORIGINAL standalone label-submission + moderator-review service
│   │   │                  (ADR 0007). The moderator-review half of this has no replacement
│   │   │                  anywhere — role-based moderation doesn't exist in the current system.
│   │   ├── case-management/   ORIGINAL standalone cases service (ADR 0011) — Case Management was
│   │   │                  retired from the live site's nav/home page separately from this
│   │   │                  session's changes.
│   │   ├── visualizer/    ORIGINAL standalone one-hop graph service — the live site's Visualizer
│   │   │                  is now packages/web/src/visualizer/, calling packages/server.
│   │   ├── tracer/        ORIGINAL standalone multi-hop tracing service (ADR 0008) — the live
│   │   │                  site's Tracer is now packages/web/src/tracer/, its own investigation
│   │   │                  canvas, calling packages/server.
│   │   └── risk-scoring/  ORIGINAL standalone risk-score service (ADR 0010) — the live site's
│   │                      risk card comes through packages/web/src/RiskPanel.tsx instead.
│   │   (a `packages/features/bounties/` also existed here; it's been deleted — bounties now
│   │   lives entirely in packages/server/src/routes/bounties.ts.)
│   └── web/                the real React UI — talks to packages/server over HTTP
│                            (packages/web/src/kit/api.ts), not the Explorer/Visualizer APIs this
│                            paragraph used to describe.
├── data/
│   └── labels/            seed label data, each entry sourced and dated
├── scripts/
│   ├── ingest-ofac-sdn.ts fetches the real OFAC SDN list, writes data/labels/ofac-sdn.json
│   ├── ingest-uk-sanctions.ts          UK Sanctions List → data/labels/uk-sanctions-list.json
│   └── ingest-safe-deployments.ts      Safe's official deployments → data/labels/safe-deployments.json
└── docs/adr/               durable architecture decisions and why they were made
```

**Why the change:** the project started as one independent standalone service per feature (the
plugin-architecture bet described below). In practice, that meant every feature needed its own
server process, its own port, and ran into real duplicated-auth and cross-origin wiring problems
as features that depended on each other (private labels, moderation, cases — all needing
accounts) multiplied. ADR 0022 consolidated the actual live backend into one unified server with
one auth system (now wallet-based) and one set of routes, while keeping the same plugin discipline
*within* that server (routes/, chain/, auth/ as clean boundaries) rather than across OS processes.
The original standalone packages under `packages/features/` aren't necessarily deleted — some are
kept specifically for their own real test coverage — but they are not what a visitor to the live
site talks to.

## The core data model

Defined once, in `packages/core/src/types.ts`, and reused by every chain adapter and feature.
Deliberately mirrors the shape that on-chain intelligence tools converge on (this is a proven
shape, not an invention — see [ADR 0001](docs/adr/0001-plugin-architecture.md) for the research
this came from):

- **Address** — `{ chain, value }`. The base unit; always scoped to a specific chain. `value` is
  canonical (`canonicalAddress` in `packages/core/src/addressFormat.ts`): lowercase hex on
  Ethereum, exact base58 on Solana. Stores match addresses exactly, so new data must use this form.
- **Entity** — a real-world actor, holding a set of `Address`es that can span multiple chains.
- **Label** — at most one per address: a human-readable identity (`"Binance 14"`). Always carries
  a `Source`. Either an `IngestedLabel`, produced by an ingestion script from an official source,
  with no `reviewStatus`, or a person-submitted `CommunityLabel` / `ConfirmedLabel`, with
  `reviewStatus: "community" | "confirmed"` and the submitter's and confirmer's account ids. See
  [ADR 0007](docs/adr/0007-community-label-submissions-and-review.md).
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
  // `before`: a `nextCursor` from a previous page, for the next-older page (ADR 0018).
  getRecentTransactions(address: string, limit: number, options?: { before?: string }): Promise<TransactionsResult>;
}

type TransactionsResult =
  | { available: true; transactions: TransactionSummary[]; nextCursor?: string }
  | { available: false; reason: string };
```

`getRecentTransactions` returns a typed "unavailable" result (with a human-readable reason) rather
than throwing or returning an empty array when data genuinely can't be fetched (e.g. no API key
configured) — callers can tell "there are no transactions" apart from "we couldn't check."

### Adding a new chain

The steps below (1-2, 4) describe the original `ChainAdapter`/`packages/chains/` plugin boundary,
which is still real and still how chain-specific logic is isolated. Step 3 is corrected for the
unified server: the live site wires chains as a `Record<Chain, ChainProvider>` constructed in
`packages/server/src/app.ts` (the `ChainProvider` interface itself is
`packages/server/src/chain/types.ts`), not a registry inside a standalone Explorer service —
confirm against those two files, this section wasn't re-verified in full detail, only the
registration point.

1. Create `packages/chains/<chain-name>/`.
2. Implement `ChainAdapter` against real data for that chain — no mocked responses.
3. Wire it into `packages/server/src/app.ts`'s `providers` map (not
   `packages/features/explorer/src/registry.ts`, which belonged to the retired standalone Explorer
   service).
4. Write a `README.md` in your chain folder: what RPC/API it talks to, what needs an API key (if
   anything), and what it can't do yet.

## The Explorer feature

**Updated 2026-10-23:** this section described `packages/features/explorer`, the original
standalone service, as "the first feature module." The live site's Explorer view
(`packages/web/src/explorer/`) now calls the unified `packages/server` instead — same basic shape
(chain + address → balance + recent transactions + any label/tag), different implementation. The
standalone package may still exist and/or be test-covered; it is not what production traffic hits.

Every later feature (Visualizer, Tracer, Risk Scoring, Case Management, Bounties, Alerts, Labels)
follows the same consuming shape today, just as routes on `packages/server` rather than as their
own standalone processes — see the Layout section above for why that changed (ADR 0022).

## Why not one shared "god" backend file

A single backend file that branches on `if (chain === 'ethereum')` everywhere is exactly what
makes a codebase hard for a newcomer (or an agent) to extend safely — every change risks breaking
an unrelated chain. The plugin boundary (one folder per chain, one typed interface) means a
contributor adding Bitcoin support can't accidentally break Solana, and doesn't need to understand
Solana's code to do their work.

## What's explicitly not solved yet

See the status table in [`README.md`](README.md). Most importantly: this only covers two chains,
has a small seed labelset, and its real-time layer only covers the addresses the background
indexer already refreshes (ADR 0013) — all deliberate scope cuts, not hidden limitations.
