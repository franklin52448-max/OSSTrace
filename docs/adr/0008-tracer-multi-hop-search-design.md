# ADR 0008 — Tracer's multi-hop search design

Status: Decided 2026-10-22 (implemented in `packages/features/tracer/`)

## Context

The Visualizer (ADR-less, see its README) draws exactly one hop: the queried address and its
direct counterparties. Tracer is the next step — following fund flow *further* than one hop — but
"further" has no natural stopping point: a real address graph fans out fast, and every hop means
one more real `ChainAdapter.getRecentTransactions` call per node touched. Left unbounded, a single
request could make hundreds of RPC calls against a public endpoint that already rate-limits a
single Visualizer request hard (see the Visualizer README's "Cost per request" section).

Two real product questions needed answering, not just the engineering one:

1. What does Tracer actually produce — a bigger version of the Visualizer's graph, or a different
   shape entirely?
2. The project's first planned bounty (`ROADMAP.md` Wave 7) describes an AI agent answering
   questions like *"did wallet A send wallet B more than $100 of USDC within 30 days?"* — that's
   not "show me a graph," it's "does a specific qualifying path exist." Tracer needs to answer
   that directly, not make the agent re-derive it from a big graph dump.

## Decision

### 1. Tracer exposes two real capabilities, not one

- **`traceGraph`** — the Visualizer's one-hop graph, extended outward for real, up to `maxHops`.
  Same `GraphEdge` shape (it's imported directly from `@osstrace/visualizer`, not reimplemented).
- **`tracePath`** — "does a path from A to B exist where every hop matches these filters (token,
  minimum amount, time window)?" This is the one the planned AI-agent bounty actually needs: a
  direct, checkable answer with the real edges as evidence, not a graph the caller has to search
  itself.

Both reuse Visualizer's `deriveGraph(address, transactions)` as the one real building block: one
call, one address, one hop's worth of real edges. Multi-hop search is BFS over repeated calls to
that function — nothing new was invented for single-hop edge resolution.

### 2. Filters apply to every hop individually, not "somewhere in the path"

`tracePath`'s filters (token, minimum amount, time window) must hold on *every* edge in the
returned path. Tracing "did A's funds reach B" means following one continuous qualifying flow.
Finding an unrelated matching edge two hops off the real path and calling that "a path" would be a
wrong answer dressed as a right one — exactly the kind of thing this project's sourcing rules exist
to prevent elsewhere.

### 3. No cross-token or token-to-USD conversion, anywhere

A `minAmount` filter compares a token's own amount in its own unit — `"USDC" minAmount "100"`
works directly because USDC is itself ~$1. There is no "$100 of ETH" filter, because that requires
a price oracle this project doesn't have and wasn't asked to build. This mirrors the Visualizer's
own `NodeStats` design (native and token totals are never summed together, for the same reason:
it would mean inventing an exchange rate). Breadth-ranking (below) uses recency instead of amount
for the same reason — comparing a native amount against a token amount to decide which is "bigger"
would be the same invented exchange rate by another name.

### 4. Hard caps, and the result always says honestly whether a cap was hit

Four bounds, all clamped server-side regardless of what a caller requests:

| Option | Default | Max |
|---|---:|---:|
| `maxHops` | 2 | 3 |
| `breadth` (distinct counterparties expanded per node) | 5 | 10 |
| `txLimitPerNode` | 10 | 50 |
| `maxAdapterCalls` (hard total call ceiling) | 40 | 100 |

Breadth ranks a node's counterparties by most-recent activity and expands only the top `breadth`
of them — every real edge found is still kept and returned (frontier nodes are never silently
dropped), it just isn't expanded past. `maxAdapterCalls` is the real circuit breaker: it can be hit
well before `maxHops`/`breadth` would otherwise stop the search, on a popular address with a large
real fan-out.

Every result distinguishes, honestly, three different reasons a node wasn't expanded further —
`depth-cap`, `breadth-cap`, `budget-exhausted` — plus `unavailable` when the chain adapter itself
couldn't check a node (an RPC failure, not a dead end). `tracePath`'s `found: false` always comes
with `budgetExhausted: true | false`: `false` means the reachable, filter-matching graph was
genuinely exhausted within the configured hops (a real negative); `true` means a cap was hit before
the search could finish (an unproven negative). Collapsing those into one "no" would be exactly the
kind of false confidence this project's sourcing/honesty rules exist to prevent — see the
Visualizer's own `TransactionsResult.available`/`reason` precedent for the same principle.

### 5. Single-chain only, in this version. No bridges.

Both `traceGraph` and `tracePath` take one `ChainId` and never cross chains. ADR scope: ETH and
Solana only (the two chains OSSTrace already supports), per the operator's explicit decision when
this was scoped (2026-10-22) — Bitcoin/Tron and bridge-hop tracing are real future work, not cut
corners hidden here. The ROADMAP already names cross-chain bridge tracing as part of Tracer's
eventual full scope; this ADR only covers what's actually built now.

### 6. No caching, no new data provider

Reuses the existing public/Helius RPC configuration (`ETH_RPC_URL`/`SOLANA_RPC_URL` in `.env`) and
Explorer's bootstrap for chain wiring and the label store — same documented exception Visualizer
already takes (see its README, "How it plugs in"). A popular trace will be slow and more exposed to
public-RPC rate limits than a one-hop Visualizer lookup; that tradeoff is accepted for v1, same as
the Visualizer's own documented rate-limit caveat.

## Consequences

- A contributor adding a new chain only needs its `ChainAdapter` — Tracer needs no chain-specific
  code of its own, same as the Visualizer.
- The AI-agent bounty (ROADMAP.md Wave 7) has a real, direct API to call (`tracePath`) instead of
  needing its own graph-search logic — but it must still handle `found: false` honestly rather than
  reporting "not connected" when `budgetExhausted` is true.
- A future price-oracle integration, if ever built, would need its own ADR — this one explicitly
  does not attempt cross-token comparison, and nothing here should be read as having decided how
  that would eventually work.
