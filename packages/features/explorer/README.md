# @osstrace/explorer

The first feature: given a chain + address, returns its balance, recent transactions, and any
label/tags/entity on record. Every later feature (Visualizer, Tracer, Risk Scoring) builds on this
same data layer.

## Running it

```sh
npm run dev --workspace packages/features/explorer
# or, from the repo root:
npm run dev:explorer
```

Reads `.env` from the repo root (`ETH_RPC_URL`, `ETHERSCAN_API_KEY`, `SOLANA_RPC_URL`, `PORT`,
`REDIS_URL`) — see the root `.env.example`. Listens on `PORT` (default 5300, this project's
assigned port block).

## Caching and the background indexer

Every lookup goes through `cachedLookupAddress` (`src/cachedLookup.ts`): a cache hit never
touches the chain adapter at all, and every lookup (hit or miss) records a popularity hit. Real
numbers, verified against a real local Redis instance: a cold Ethereum lookup takes ~160ms, a
cached one ~15–20ms.

Reports are cached per address **and** per transaction limit (`reportCacheKey(address, limit)` →
`ethereum:0xabc|limit=25`), so `?limit=5` and `?limit=50` on the same address are two separate
entries and never served for each other. Popularity hits stay per address only (plain
`ethereum:0xabc`) — demand is a property of the address, not of the limit. The indexer refreshes
each hot address at `DEFAULT_TX_LIMIT` (25, the API's default when no `?limit=` is given), under
that same limit-aware key. A lookup with a non-default limit is cached normally for its TTL but
isn't kept warm by the indexer.

Only **chain data** (balance, transactions) is served from the cache. Label, tags and entity are
re-read from the label store on every lookup, hit or miss. These are cheap local reads, and
community labels change through moderation, so a label confirmed or rejected a moment ago shows
up on the next lookup instead of after the cache TTL.

## Where labels come from

`buildLabelStore()` (`src/bootstrap.ts`) is a `CompositeLabelStore` over every ingested dataset
in `data/labels/`, in priority order. After those comes a read-only `CommunityLabelReader` over
community submissions
([`@osstrace/community-labels`](../community-labels/README.md), ADR 0007). An official source's
label always wins. A community label comes back with `reviewStatus: "community"` (unreviewed) or
`"confirmed"` (reviewed by a moderator), plus `submittedBy`/`confirmedBy` account ids. Ingested
labels have no `reviewStatus`. Reading community labels doesn't need the community-labels server
running, because the Explorer reads its file (`COMMUNITY_LABELS_PATH`) directly.

Without `REDIS_URL` set, this uses `InMemoryCache` — fine for one process, but **not shared**
across processes. The background indexer (`src/indexer.ts`) is a separate process that keeps the
most-looked-up addresses warm on a schedule, which only does anything useful once it shares a
cache with the API server — so it needs `REDIS_URL` set to the same Redis instance:

```sh
# terminal 1
REDIS_URL=redis://127.0.0.1:6379 npm run dev --workspace packages/features/explorer
# terminal 2
REDIS_URL=redis://127.0.0.1:6379 npm run indexer --workspace packages/features/explorer
```

Verified for real (not just unit-tested): started the server and indexer as two separate OS
processes against a real local Redis, looked up two real Ethereum addresses through the server,
and confirmed the indexer — in its own process, having never seen those requests — picked up the
exact same popularity ranking from Redis and refreshed both addresses on its own schedule.

Without Redis, the indexer can instead run **inside** the API process, sharing its in-memory cache
(same indexer, same RPC cost — don't also run the separate one):

```sh
EXPLORER_EMBEDDED_INDEXER=1 npm run dev:explorer
```

The indexer logic lives in `src/indexing.ts` (`Indexer`, with a `runCycle()` tests call directly);
`src/indexer.ts` is only the process entry point.

## Real-time streaming (websocket)

`ws://localhost:5300/stream` — on the Explorer's own HTTP server, no extra port. Subscribe to an
address and you're pushed each real new transaction the background indexer finds for it. Design
and the reasoning behind every rule below: [ADR 0013](../../../docs/adr/0013-real-time-streaming-rides-the-indexer.md).

### Protocol

```jsonc
// client → server
{ "subscribe":   { "chain": "solana", "address": "EPjF..." } }
{ "unsubscribe": { "chain": "solana", "address": "EPjF..." } }

// server → client
{ "event": "subscribed", "chain": "solana", "address": "EPjF...", "live": true }
{ "event": "subscribed", "chain": "solana", "address": "EPjF...", "live": false,
  "cause": "not_indexed", "reason": "This address isn't among the 20 most-looked-up ..." }
{ "event": "status", ... }            // same shape; sent only when `live`/`cause` actually changes
{ "event": "new_transaction", "chain": "solana", "address": "EPjF...",
  "transaction": { /* a real TransactionSummary, exactly as the HTTP API returns it */ },
  "detectedAt": "2026-10-22T01:00:44.533Z" }
{ "event": "possible_gap", ... }      // a full window of new txs: more may have happened; re-fetch over HTTP
{ "event": "unsubscribed", "chain": "solana", "address": "EPjF..." }
{ "event": "error", "message": "..." } // bad JSON, unsupported chain, too many subscriptions
```

`cause` when not live: `no_indexer_cycle` (no indexer has reported to this server — not running,
or not on the same `REDIS_URL`), `indexer_stopped` (it has, but not recently), `not_indexed` (not
in the indexer's top-N), `history_unavailable` (indexed, but the last fetch couldn't read
transactions, e.g. no `ETHERSCAN_API_KEY` or an RPC 429). A not-live subscription stays open; a
`status` event announces it when that changes.

### Exactly what triggers a push

Each indexer cycle refetches the top-N addresses (it always did, to keep the cache warm). For each
one, it diffs the fetched transaction hashes against **that address's previous successful fetch**:
a hash that wasn't there before is a `new_transaction`. The first fetch of an address only sets the
baseline (nothing pushed — no way to tell new from old without one). A failed fetch keeps the old
baseline. Details, including the edge-of-window guard, in `src/txDiff.ts` and ADR 0013.

The indexer publishes these on an `IndexerEventBus` — Redis pub/sub (`RedisEventBus`) when
`REDIS_URL` is set, so the separate indexer process reaches the API server; in-process otherwise,
which only works with `EXPLORER_EMBEDDED_INDEXER=1`.

### Cost

**Zero new RPC calls.** The pushes are a set diff over data the indexer was already fetching.
Total chain-adapter load is identical with zero subscribers or thousands; subscribing doesn't
count as a lookup and never adds an address to the indexer's list.

### Limitations

- **Only addresses in the indexer's top-N (`INDEXER_TOP_N`, default 20) get live pushes.**
  Everything else is told `live: false, cause: "not_indexed"` — never silently promised updates.
- **Lag:** up to one indexer interval (`INDEXER_INTERVAL_MS`, default 30s) plus one cycle's
  duration, plus however far the adapter's own source lags the chain. Not block-level real time.
- At most 25 new transactions per address per cycle (the indexer's window); beyond that you get a
  `possible_gap` instead of the rest.
- Ethereum needs `ETHERSCAN_API_KEY` for transaction history at all; without it Ethereum
  subscriptions report `history_unavailable`.
- After an indexer restart its first cycle re-baselines silently; a transaction landing in that
  window isn't pushed (it's still in the HTTP response).
- Run one indexer per Redis — two would double RPC load and duplicate every push.
- No auth, no `Origin` check, no per-IP connection limit (25 subscriptions per connection, 4 KB
  frames, 30s heartbeat). Fine for local dev; add those before any public deployment.

Verified live, not just in tests: with `EXPLORER_EMBEDDED_INDEXER=1`, `INDEXER_INTERVAL_MS=10000`,
a real HTTP lookup of Solana's USDC mint followed by a websocket subscribe got `not_indexed`
(the indexer hadn't run since the lookup), a `status: live` at the next cycle, then 75 real
`new_transaction` pushes over three cycles — none of them in the original HTTP response — each
cycle ending in a `possible_gap`, which is correct for an address that busy. Ethereum without an
Etherscan key correctly reported `history_unavailable`.

The web UI's Lookup view subscribes automatically while a report is on screen
(`packages/web/src/LiveStream.tsx`): a `LIVE` / `Not live` chip in the transactions header (with
the server's reason shown when not live), pushed transactions prepended with a `NEW` chip.

## API

`GET /address/:chain/:address` — `chain` is `ethereum` or `solana`. An Ethereum address is
lowercased (hex case is only a checksum); a Solana address is used exactly as given. Bad input is a
`400` before anything reaches a chain adapter or the popularity ranking: an unsupported chain, an
address that isn't well-formed for its chain, or a malformed `%`-escape in the path. `?limit=`
(transactions to fetch) is a whole number from 1 to 100; a missing, zero, negative or non-numeric
value means the default (25), and anything above 100 is capped at 100. The request handler lives
in `src/http.ts` (`createExplorerHandler`); `src/server.ts` only wires it up and listens.

```
curl http://localhost:5300/address/ethereum/0x252a8bd2319d8a555b872990601221b3a2053bce
```

Returns an `AddressReport`:

```json
{
  "address": { "chain": "ethereum", "value": "0x..." },
  "balance": { "chain": "ethereum", "address": "0x...", "native": { "symbol": "ETH", "amount": "1.5", "decimals": 18 }, "asOf": "..." },
  "transactions": { "available": true, "transactions": [ { "hash": "...", "...": "..." } ] },
  "label": null,
  "tags": [],
  "entity": null
}
```

`transactions` is `{ "available": false, "reason": "..." }` instead of an empty list when the
underlying chain adapter couldn't fetch history (e.g. no `ETHERSCAN_API_KEY`) — see
`packages/chains/README.md`.

`GET /health` — `{ "ok": true }`.

## What's not built here yet

- No pagination beyond a `?limit=` query param on transactions.
- CORS is wide open (`*`) — correct for a local dev tool talking to a local web UI, wrong for any
  public deployment. Flagging this explicitly so it isn't carried forward by accident.
- No deployment story for the indexer as a long-running process (systemd/pm2/a Fly machine) —
  today it's just a script you run in a terminal.

## Testing

`tests/http.test.ts` runs the real request handler behind a real HTTP server: input validation,
`?limit=` clamping, and that a malformed request can't take the server down.

Streaming tests: `txDiff.test.ts` (the new-transaction rule), `indexing.test.ts` (the real
`Indexer` publishing events, with adapter call counts proving no extra RPC), `stream.test.ts`
(a real HTTP server + real `ws` client end to end; each indexer cycle is triggered with
`runCycle()` instead of waiting on the timer, against a scripted adapter whose history the test
edits between cycles), and `redisEventBus.test.ts` (real Redis pub/sub across two connections;
skips cleanly if no Redis at `REDIS_TEST_URL`, default `redis://127.0.0.1:6379`).

`npm test` also runs `lookup.test.ts` and `cachedLookup.test.ts` against a real temp-file-backed
`JsonFileLabelStore`, `InMemoryCache`, and a small concrete `ChainAdapter` stand-in with a call
counter (not a mocking framework) — proves a cache hit genuinely skips the adapter, not just that
the code compiles. The chain adapters' own real-network tests live in their own packages.
