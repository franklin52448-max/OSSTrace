# @osstrace/tracer

Follows fund flow further than one hop. Where the Visualizer draws exactly an address and its
direct counterparties, Tracer answers two different, real questions:

- **`GET /trace/graph/:chain/:address`** — expand the graph outward for real, up to a few hops,
  honestly marking which nodes were reached but not expanded further, and why.
- **`GET /trace/path/:chain?from=&to=`** — does a path exist from one address to another where
  every hop carries a specific token, at least a minimum amount, within a time window? This is
  the direct question behind "is wallet A connected to wallet B" / "did A send B more than $100 of
  USDC in the last 30 days" — see `ROADMAP.md`'s planned AI-agent bounty.

Design rationale, caps, and why filters apply per-hop rather than anywhere in the path: see
[ADR 0008](../../../docs/adr/0008-tracer-multi-hop-search-design.md). A real "Trace" tab in the
web UI (`packages/web/src/TracerView.tsx`) calls both endpoints directly — see its own note under
"What's not built yet" for what that UI doesn't do yet.

## Running it

```sh
npm run dev --workspace packages/features/tracer
# or, from the repo root:
npm run dev:tracer
```

Reads the root `.env` the same way Explorer and Visualizer do (`ETH_RPC_URL`, `ETHERSCAN_API_KEY`,
`SOLANA_RPC_URL`). Listens on `TRACER_PORT`, default **5303** — a separate variable from `PORT`
(Explorer) and `VISUALIZER_PORT`, since all three run side by side.

## How it plugs in

- **Chain data:** reuses Visualizer's `deriveGraph` (one real building block: one address's own
  transactions in, that node's real edges out) and `@osstrace/core`'s `ChainAdapter`. No new
  chain-level code — adding a chain here means nothing, same as the Visualizer.
- **Chain wiring + label store:** reused from Explorer's `bootstrap.ts`, the same documented
  exception the Visualizer already takes (see its README, "How it plugs in") rather than a third
  copy of the same registration code.
- **Everything else is new here**: the multi-hop BFS itself (`src/trace.ts`) and the filter
  matching for `tracePath` (`src/filters.ts`).

## API

### `GET /trace/graph/:chain/:address?maxHops=&breadth=&txLimit=&maxCalls=`

```
curl "http://localhost:5303/trace/graph/solana/9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM?maxHops=2"
```

Returns `{ center, nodes, edges, expandedIds, frontier, adapterCallsUsed, budgetExhausted }`.

- `edges` — every real edge found, same `GraphEdge` shape as the Visualizer (native + decoded
  token edges). Never pruned just because a node wasn't expanded past — see ADR 0008 §4.
- `nodes` — every node reached, each carrying its real label/tags/entity from the label store,
  and a `role`: `"center"`, `"expanded"` (its own transactions were fetched), or `"frontier"`
  (reached via an edge, but not expanded — check `frontierReason`).
- `frontier` — `{ id, reason }` for every node not expanded further. `reason` is one of
  `"depth-cap"`, `"breadth-cap"`, `"budget-exhausted"`, or `"unavailable"` (the chain adapter
  itself couldn't check it — an RPC failure, not a dead end). These mean different things; never
  treat any of them as "no further connections exist".
- `budgetExhausted` — `true` only when `maxAdapterCalls` was hit before the configured
  `maxHops`/`breadth` finished. Reaching the configured depth/breadth by design is not this.

### `GET /trace/path/:chain?from=&to=&token=&minAmount=&since=&until=&maxHops=&breadth=&txLimit=&maxCalls=`

```
curl "http://localhost:5303/trace/path/solana?from=<A>&to=<B>&token=USDC&minAmount=100&since=2026-09-01T00:00:00Z"
```

`token`, `minAmount`, `since`, `until` are all optional filters — omit all of them to ask "is there
*any* path at all." Returns `{ from, to, filters, found, path, nodes, hopsSearched, nodesExplored, adapterCallsUsed, budgetExhausted }`.

- `found: true` → `path` is the real sequence of edges from `from` to `to`, every one of them
  individually satisfying every filter (ADR 0008 §2) — not a plausible-looking answer, the actual
  on-chain evidence.
- `found: false` → **check `budgetExhausted` before concluding "not connected".** `false` means
  the search genuinely ran out of reachable, filter-matching graph within `maxHops` — a real
  negative. `true` means a cap was hit first — the search didn't finish, so "not found" here means
  "not found *yet*", not "disproven". An AI agent calling this must surface that distinction, not
  flatten it into one confident-sounding "no".
- `minAmount` compares a token's own amount in its own unit — `token=USDC&minAmount=100` works
  because USDC is ~$1 per unit. There is no cross-token or USD-value filter; see ADR 0008 §3.

`GET /health` returns `{ "ok": true }`.

Errors: `400` for an unsupported chain or an invalid address for it. `502`
(`{ "error": "..." }`) when the adapter throws (e.g. the public RPC rate-limits the request).

## Cost per request

Worst case is `1 + breadth + breadth²` adapter calls for `maxHops=2` at the default `breadth=5` —
31 calls, each itself one or more real RPC calls (see the Visualizer README's own "Cost per
request" section for what one `getRecentTransactions` call costs per chain). `maxAdapterCalls`
(default 40) catches this before it gets much larger; a `maxHops=3` request on a well-connected
address will very likely hit it. For real use beyond a quick trace, set `SOLANA_RPC_URL`/
`ETH_RPC_URL` to a private RPC — same advice the Visualizer README already gives, more true here
since Tracer makes more calls per request by design.

## What's not built yet

- **No multi-chain / bridge tracing.** `traceGraph` and `tracePath` both take one chain and never
  cross it. Cross-chain bridge-hop tracing is real future scope (see ROADMAP.md), not attempted
  here.
- **No caching.** Same as the Visualizer — every request reaches the chain adapter fresh.
- **No AI agent yet.** Tracer exists so one can be built against it (ROADMAP.md Wave 7's first
  planned bounty); this package is the real tool the agent would call, not the agent itself.
- **The web UI's Trace tab lists results, it doesn't draw an interactive graph.** `traceGraph`
  results (edges + frontier) show as plain lists, not the Visualizer's force-layout canvas —
  that canvas is built for a one-hop graph's shape; adapting it for a multi-hop one is real
  future work, not attempted here.
- **No price oracle / cross-token USD filter.** See ADR 0008 §3 — deliberately not attempted.

## Testing

`npm test` runs `tests/trace.test.ts`. A small concrete `MapChainAdapter` stand-in (not a mocking
framework) gives each test address its own fixed transaction list, or none at all (to exercise the
`"unavailable"` frontier reason honestly). Covers: hop-by-hop expansion keeping every real edge;
breadth capping by recency while still surfacing capped nodes; the `budgetExhausted` distinction
from a depth/breadth cap reached by design; a real multi-hop path found under per-hop filters; a
real edge that exists but fails a filter (a genuine negative, `budgetExhausted: false`); a real
path that exists past the depth cap (`budgetExhausted: true`); the zero-call `from === to` case;
and real label/tag/entity lookups wired through `buildTraceGraph`/`buildTracePath`.
