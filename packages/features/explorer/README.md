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
`REDIS_URL`, `EXPLORER_ALLOWED_ORIGINS`) — see the root `.env.example`. Listens on `PORT` (default 5300, this project's
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
  "balance": { "available": true, "balance": { "chain": "ethereum", "address": "0x...", "native": { "symbol": "ETH", "amount": "1.5", "decimals": 18 }, "asOf": "..." } },
  "transactions": { "available": true, "transactions": [ { "hash": "...", "...": "..." } ] },
  "label": null,
  "tags": [],
  "entity": null
}
```

`transactions` is `{ "available": false, "reason": "..." }` instead of an empty list when the
underlying chain adapter couldn't fetch history (e.g. no `ETHERSCAN_API_KEY`) — see
`packages/chains/README.md`.

`balance` works the same way: `{ "available": false, "reason": "..." }` when the balance call
failed (the RPC is down, say). The two chain calls are made independently, so one failing never
hides the other, and never hides the label/tags/entity, which are local reads. That's still a
`200`. A `502` now only means the lookup as a whole failed (e.g. the label store couldn't be
read). A report with a failed balance isn't cached, so the next lookup retries right away.
Reasoning: [ADR 0014](../../../docs/adr/0014-explorer-reports-balance-failure-without-hiding-the-rest.md).

### Paging back through history: `?before=`

When there may be older history, `transactions` carries a `nextCursor`. Pass it back unchanged as
`?before=` (with the same `?limit=`, or a different one) for the next-older page. It never
overlaps the page it came from and never skips anything between them. No `nextCursor` means
that page reached the end. A page that was exactly full at the end can still carry one, whose
next page is empty.

```
curl 'http://localhost:5300/address/solana/<address>?limit=10'
# → "transactions": { "available": true, "transactions": [...], "nextCursor": "4Nd1m..." }
curl 'http://localhost:5300/address/solana/<address>?limit=10&before=4Nd1m...'
```

The cursor is each chain's own native one, built by the chain adapter: a transaction signature on
Solana (`getSignaturesForAddress`'s `before`), and a block position on Ethereum (Etherscan's
`endblock`, see the [Ethereum README](../../chains/ethereum/README.md)). Treat it as opaque. A
`?before=` that can't be any chain's cursor (characters other than letters, digits and `:`, or
over 128 characters) is a `400`. A well-formed one the chain's adapter can't use comes back as
`transactions: { "available": false, "reason": "..." }`, with a reason saying so. Without
`?before=`, nothing changes: same request to the chain, same cache entry, the one the indexer
keeps warm. Each `limit` + cursor pair is its own cache entry. Design:
[ADR 0018](../../../docs/adr/0018-cursor-pagination-uses-each-chains-native-cursor.md).

`GET /health` — `{ "ok": true }`.

### CORS

Browsers may call the API only from origins on an exact allowlist, the same pattern as the
accounts API. Never `*`. An allowed `Origin` is reflected back in `Access-Control-Allow-Origin`.
Any other origin gets no CORS header, so the browser blocks the page from reading the response.
Every response carries `Vary: Origin`, and an `OPTIONS` preflight gets a `204`. Set
`EXPLORER_ALLOWED_ORIGINS` (comma-separated). If it's unset or empty, the Explorer uses
`ACCOUNTS_ALLOWED_ORIGINS`, and if that's also unset, the web UI's dev server,
`http://localhost:5301`. The server logs the list it's using at startup. In code:
`createExplorerHandler({ ..., allowedOrigins })`, with `allowedOriginsFromEnv()` in
`src/bootstrap.ts`. CORS only governs browsers. `curl` and server-side callers aren't affected.

## Running the indexer as a long-lived service

`deploy/` has two ready-to-use configs for the background indexer. Both run the repo's own
`npm run indexer --workspace packages/features/explorer` (the same thing `npm run dev:indexer`
runs), restart it when it crashes but not after a clean exit, and read the repo root `.env`. Pick
one:

- **systemd**: [`deploy/osstrace-indexer.service`](deploy/osstrace-indexer.service). Assumes a
  checkout at `/opt/osstrace` running as an `osstrace` system user, with
  `EnvironmentFile=-/opt/osstrace/.env`, `Restart=on-failure` and `KillMode=control-group`, so
  stopping it stops the node child too, not just npm. The install steps are in the file's header.
  Change the three `/opt/osstrace` paths if your checkout lives elsewhere. Logs go to
  `journalctl -u osstrace-indexer`.
- **pm2**: [`deploy/ecosystem.config.cjs`](deploy/ecosystem.config.cjs). Finds the repo root from
  its own location, so `pm2 start packages/features/explorer/deploy/ecosystem.config.cjs` works
  from anywhere. Settings: `stop_exit_codes: [0]` (the on-failure policy), `treekill`, and one
  instance.

Either way, set `REDIS_URL` in `.env` to the same Redis the API server uses. Without it, the
indexer warms only its own in-memory cache, which no API server can see, and says so at startup.
Run exactly one indexer per Redis. Two would double RPC load and duplicate every live push.

## What's not built here yet

- The web UI doesn't page yet. It shows the first page only; `?before=` is API-only for now.
- The websocket (`/stream`) has no `Origin` check of its own yet (see Real-time streaming →
  Limitations). The CORS allowlist above covers the HTTP API only.
- No deploy config for the Explorer API server itself or for a hosted platform (e.g. a Fly
  machine). `deploy/` covers the indexer, on a machine you run.

## Testing

`tests/http.test.ts` runs the real request handler behind a real HTTP server: input validation,
`?limit=` clamping, `?before=` validation and cache separation, and that a malformed request
can't take the server down. `tests/paging.test.ts` pages through `?before=` end to end with the
real chain adapters. On Ethereum the adapter talks to a local server answering `txlist`/`tokentx`
from recorded real mainnet rows (no key needed), and the test walks the whole history page by
page. On Solana it uses the live public RPC and skips if refused.

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
