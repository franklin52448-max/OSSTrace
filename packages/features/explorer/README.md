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

## API

`GET /address/:chain/:address` — `chain` is `ethereum` or `solana`.

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

`npm test` runs `lookup.test.ts` and `cachedLookup.test.ts` against a real temp-file-backed
`JsonFileLabelStore`, `InMemoryCache`, and a small concrete `ChainAdapter` stand-in with a call
counter (not a mocking framework) — proves a cache hit genuinely skips the adapter, not just that
the code compiles. The chain adapters' own real-network tests live in their own packages.
