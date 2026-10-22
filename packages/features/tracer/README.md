# @osstrace/tracer

Follows fund flow further than one hop. Where the Visualizer draws exactly an address and its
direct counterparties, Tracer answers two different, real questions:

- **`GET /trace/graph/:chain/:address`** — expand the graph outward for real, up to a few hops,
  honestly marking which nodes were reached but not expanded further, and why.
- **`GET /trace/path/:chain?from=&to=`** — does a path exist from one address to another where
  every hop carries a specific token, at least a minimum amount, within a time window? This is
  the direct question behind "is wallet A connected to wallet B" / "did A send B more than $100 of
  USDC in the last 30 days" — see `ROADMAP.md`'s planned AI-agent bounty.

Both can optionally **cross between Ethereum and Solana through Wormhole** (`?bridges=wormhole`).
A real Wormhole transfer becomes a `kind: "bridge"` edge carrying both chains' real tx hashes, and
the trace continues on the other chain. See "Cross-chain bridge hops" below and
[ADR 0012](../../../docs/adr/0012-tracer-cross-chain-bridge-hops-via-wormhole.md).

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
- **Everything else is new here**: the multi-hop BFS itself (`src/trace.ts`), the filter
  matching for `tracePath` (`src/filters.ts`), and Wormhole bridge-hop resolution
  (`src/bridges/wormhole.ts`, edge shape in `src/edges.ts`).
- **Bridge data (only with `?bridges=wormhole`):** Wormhole's public Wormholescan API
  (`https://api.wormholescan.io`, no key; override with `WORMHOLESCAN_API_URL`). This is the one
  external service Tracer calls that isn't a chain adapter. ADR 0012 explains why it's acceptable
  under ADR 0004/0005.

## API

### `GET /trace/graph/:chain/:address?maxHops=&breadth=&txLimit=&maxCalls=&bridges=`

```
curl "http://localhost:5303/trace/graph/solana/9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM?maxHops=2"
```

Returns `{ center, nodes, edges, expandedIds, frontier, nodeChains, adapterCallsUsed, budgetExhausted, bridges }`.

- `edges` — every real edge found, same `GraphEdge` shape as the Visualizer (native + decoded
  token edges), plus `kind: "bridge"` edges when `bridges=wormhole` (see below). Never pruned
  just because a node wasn't expanded past — see ADR 0008 §4.
- `nodeChains` — `{ [nodeId]: "ethereum" | "solana" }` for every node in the result. It only has
  more than one chain when bridges are on. Each `nodes[].address.chain` is that node's own chain.
- `nodes` — every node reached, each carrying its real label/tags/entity from the label store,
  and a `role`: `"center"`, `"expanded"` (its own transactions were fetched), or `"frontier"`
  (reached via an edge, but not expanded — check `frontierReason`).
- `frontier` — `{ id, reason }` for every node not expanded further. `reason` is one of
  `"depth-cap"`, `"breadth-cap"`, `"budget-exhausted"`, or `"unavailable"` (the chain adapter
  itself couldn't check it — an RPC failure, not a dead end). These mean different things; never
  treat any of them as "no further connections exist".
- `budgetExhausted` — `true` only when `maxAdapterCalls` was hit before the configured
  `maxHops`/`breadth` finished. Reaching the configured depth/breadth by design is not this.

### `GET /trace/path/:chain?from=&to=&toChain=&token=&minAmount=&since=&until=&maxHops=&breadth=&txLimit=&maxCalls=&bridges=`

```
curl "http://localhost:5303/trace/path/solana?from=<A>&to=<B>&token=USDC&minAmount=100&since=2026-09-01T00:00:00Z"
```

`token`, `minAmount`, `since`, `until` are all optional filters — omit all of them to ask "is there
*any* path at all." `toChain` is the `to` address's chain (default: the `from` chain). A `toChain`
different from `:chain` needs `bridges=wormhole`, otherwise the request gets a `400`. Returns
`{ from, to, filters, found, path, nodes, nodeChains, hopsSearched, nodesExplored, adapterCallsUsed, budgetExhausted, bridges }`.

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
- `breadth` limits which neighbours get *expanded*. If an edge Tracer has already fetched reaches
  `to` directly, it counts even when `to` isn't among that node's `breadth` most recent
  neighbours.
- An edge whose transaction has no reported timestamp (`timestamp: null`, e.g. a very recent
  Solana signature) **fails** any `since`/`until` filter, since it can't be shown to fall inside
  the window. The same rule as an unresolved amount or symbol. In `breadth` ranking, a neighbour
  reached only through such edges counts as least recent. See ADR 0016.

`GET /health` returns `{ "ok": true }`.

Errors: `400` for an unsupported chain, an invalid address for it, an unknown `bridges` value, or a
cross-chain `toChain` without `bridges=wormhole`. `502` (`{ "error": "..." }`) when the adapter
throws (e.g. the public RPC rate-limits the request).

## Cross-chain bridge hops (`bridges=wormhole`)

This is opt-in. Without it, both endpoints behave exactly as ADR 0008 describes: same calls, same
results, never leaving the start chain. With it, every node Tracer expands also gets **one**
lookup against Wormhole's public Wormholescan API
(`GET /api/v1/operations?address=<node>&pageSize=<txLimit>`). Each Wormhole operation that comes
back is handled in one of three ways:

- **It becomes a `kind: "bridge"` edge** when the node is the sender on its own chain or the
  recipient on its own chain, the other side is Ethereum or Solana, and Wormholescan reports a
  destination-chain transaction. The edge carries `sourceChain`/`targetChain` and
  `bridge: { protocol: "wormhole", operationId, appIds, sourceTxHash, targetTxHash,
  targetTimestamp, evidence: "wormholescan", evidenceUrl }`. `hash` is the source tx hash. `token`
  holds Wormholescan's reported `symbol`/`amount`, each `null` when it didn't report one. The
  trace continues from the far side using **that chain's** adapter.
- **It goes in `bridges.deadEnds`** when the node is involved but the hop can't be followed:
  `"no-destination-tx"` (Wormholescan has no destination tx; *not yet redeemed* and *redeemed but
  not indexed* can't be told apart from this source), `"counterparty-chain-unsupported"` (e.g.
  bridged to BSC or Base; the Wormhole chain ID is reported), or
  `"counterparty-address-unresolved"`.
- **It is dropped** when the node isn't on the matching side *on its own chain*. An EVM address
  is the same on Base or Arbitrum, and those are different accounts.

The response's `bridges` object is `{ enabled, protocol, lookupsUsed, lookupFailures, deadEnds,
malformedOperations }`. A failed Wormholescan call shows up in `lookupFailures` as
`{ id, chain, reason }`. That means "couldn't check for bridge activity", never "none". The
node's own chain edges are still kept.

Things to know before relying on it:

- **The cross-chain link is Wormholescan's index.** Tracer does not fetch `targetTxHash` from the
  destination chain to confirm it. Each edge's `evidenceUrl` points to the record Tracer used.
- **On Solana, a Portal Token Bridge recipient is an SPL token account**, not a wallet. This is how
  the Token Bridge protocol works (ADR 0012). The trace continues from that token account (the
  Solana adapter decodes its outgoing SPL transfers). It is not merged with the owning wallet's
  other activity.
- **A bridged token is a different token on the other side** (e.g. USDC arrives on Solana as a
  wrapped token). A `token=` filter that matches before the bridge won't necessarily match after
  it, and that's deliberate (ADR 0008 §3).
- **The bridge lookup only runs for nodes Tracer could expand.** An Ethereum node with no
  `ETHERSCAN_API_KEY` is `unavailable`, so its Wormhole activity isn't looked up either.
- **Only Wormhole is detected.** Any other bridge still dead-ends on the source chain, with nothing
  to show a bridge was involved.

## Cost per request

Worst case is `1 + breadth + breadth²` adapter calls for `maxHops=2` at the default `breadth=5` —
31 calls, each itself one or more real RPC calls (see the Visualizer README's own "Cost per
request" section for what one `getRecentTransactions` call costs per chain). `maxAdapterCalls`
(default 40) catches this before it gets much larger; a `maxHops=3` request on a well-connected
address will very likely hit it. For real use beyond a quick trace, set `SOLANA_RPC_URL`/
`ETH_RPC_URL` to a private RPC — same advice the Visualizer README already gives, more true here
since Tracer makes more calls per request by design.

With `bridges=wormhole`, each expanded node adds one Wormholescan GET, so `bridges.lookupsUsed ≤
adapterCallsUsed`, which at worst doubles the external calls. Wormholescan's API is public and
keyless. On 2026-10-22 it returned `x-ratelimit-limit: 1000` with a reset under a minute (observed
headers, not a documented guarantee). Each lookup has a 15 s timeout.

## What's not built yet

- **Bridge hops are not independently checked on-chain.** The destination tx comes from
  Wormholescan's index. Fetching it from the destination chain, and parsing the guardian-signed
  VAA to cross-check recipient/amount, is deferred (ADR 0012, "Deferred").
- **A Solana token-account recipient isn't resolved to its owner wallet.** This is also deferred
  in ADR 0012.
- **One bridge protocol (Wormhole) only.** deBridge, Allbridge, Mayan, CEX deposits used as a
  bridge, and the rest aren't detected.
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
path that exists past the depth cap (`budgetExhausted: true`); a direct edge to the target that's
outside the breadth ranking still counts; the zero-call `from === to` case; and real
label/tag/entity lookups wired through `buildTraceGraph`/`buildTracePath`.

`tests/bridges.test.ts` runs the real Wormholescan classifier against two **real, unedited
Wormholescan responses** recorded on 2026-10-22 (`tests/fixtures/wormholescan-operations-*.json`;
the exact URLs are in the test file). It checks:

- an Ethereum → Solana Portal transfer with both real tx hashes;
- the same `0x` address acting on Base/BSC/Arbitrum being dropped;
- a BSC → Ethereum transfer reported as a `counterparty-chain-unsupported` dead end;
- Solana → Ethereum transfers with no indexed destination tx reported as `no-destination-tx`.

Through traversal (a `RecordedWormholescan` resolver double that feeds those fixtures to the real
classifier, plus `MapChainAdapter` per chain), it also covers:

- a hop followed onto Solana and expanded there with the Solana adapter;
- bridging off meaning ADR 0008 unchanged;
- a failed lookup reported, not swallowed;
- a cross-chain `tracePath`;
- per-hop filters applied to bridge hops (an unreported symbol never matches; `minAmount` picks
  the qualifying real transfer);
- a cross-chain question without bridging throwing;
- bridged-to nodes labeled under their own chain.

`tests/wormholescan.live.test.ts` calls the real public API and checks that its response shape
still fits the classifier. It skips when the API is unreachable or rate-limits the request.
