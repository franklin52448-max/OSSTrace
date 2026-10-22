# ADR 0013 — Real-time streaming rides on the background indexer

Status: Decided 2026-10-22 (implemented in `packages/features/explorer/` and `packages/web/src/LiveStream.tsx`)

## Context

A web UI client looking at an address had one way to see new activity: re-fetch
`GET /address/:chain/:address`. The ROADMAP's Wave 6 asks for a real-time (websocket) layer
instead, so a client is pushed an update when one happens.

The obvious way to build that is also the wrong one here: give each subscribed client its own
polling loop against the chain adapter. Every connected client would add its own stream of
`getRecentTransactions` calls against public RPC endpoints that already rate-limit a single
Visualizer request hard (see the Visualizer and Tracer READMEs). RPC load would scale with the
number of open browser tabs. Nothing in this project is allowed to scale like that by accident.

The Explorer already has a loop that refetches addresses for real: the background indexer
(`src/indexer.ts`). Every `INDEXER_INTERVAL_MS` (default 30s) it refetches the `INDEXER_TOP_N`
(default 20) most-looked-up addresses at the default limit of 25 and rewrites their cache
entries. Those fetches already happen. What they don't do today is notice what changed.

## Decision

### 1. Pushes come only from the indexer's existing fetches. No new RPC calls, anywhere.

The indexer logic moved into a testable `Indexer` class (`src/indexing.ts`). `src/indexer.ts` is
now just the process entry point. Each cycle makes exactly the calls it made before: one
`lookupAddress` per hot address. It then also diffs the result against that address's previous
fetch and publishes what's new. The websocket layer never calls a chain adapter. It relays what
the indexer publishes. Total RPC cost is the same with zero subscribers or ten thousand.

### 2. "New since last fetch" means a hash diff between consecutive successful fetches

`diffTransactions(previous, current, limit)` in `src/txDiff.ts`:

- The indexer keeps, per address, the transaction list from its **last successful fetch** (the
  baseline). A transaction whose hash is in the current fetch and not in the baseline is new.
- **First fetch: nothing is reported.** With no baseline there's no way to tell a transaction that
  landed a second ago from one that's a year old. Reporting the whole first window as "new" would
  be a false push. The same applies after an indexer restart, since baselines live in memory.
- **The edge-of-window guard.** If the baseline filled the whole window (25 entries), it only
  covered history back to its oldest entry. An unseen hash older than that entry is an old
  transaction near the window's bottom edge (RPC responses aren't perfectly stable), not a new
  one, so it isn't reported. If the baseline window *wasn't* full, it held the address's entire
  history, so any unseen hash is new.
- **Overflow is reported, not hidden.** If every transaction in a full window is new, more may
  have happened between two fetches than one window can hold. The pushes are then real but
  possibly incomplete, so a separate `possible_gap` event says so and tells the client to re-fetch
  over HTTP.
- **A failed or unavailable fetch keeps the old baseline** and reports nothing. The next good fetch
  is diffed against the last good one, so nothing is lost and nothing is double-reported.
- **Baselines are kept only for addresses in the current cycle's top-N.** Memory is bounded by
  `INDEXER_TOP_N`. An address that drops out and later comes back starts from a fresh baseline.
  Otherwise everything that happened while it wasn't watched would be pushed as if it had just
  happened.
- New transactions are published oldest first. A client applying them in order ends up in the same
  newest-first order the HTTP API returns.

### 3. Addresses the indexer doesn't refresh are told so, and are not secretly promoted

Two options were considered for an address nobody else has looked up enough to be in the top-N:

- **(a)** Add every subscribed address to the indexer's refresh set for the life of the
  subscription. That makes RPC load scale with subscriber count again, which is exactly what
  point 1 rules out. It would also let any client force the indexer to poll arbitrary addresses.
- **(b)** Tell the client, honestly, that this address gets no live updates right now. **Chosen.**

The indexer publishes a `cycle_completed` event after each pass, listing which addresses it
refreshed with history available (`live`), which it tried but couldn't read and why (`notLive`),
its `topN`, `intervalMs` and how long the cycle took. The websocket hub uses the latest one to
answer every subscribe with `live: true`, or with `live: false` plus a machine-readable `cause`
and a human `reason`:

| `cause` | Meaning |
|---|---|
| `no_indexer_cycle` | This server has never heard from an indexer (not running, or not sharing its `REDIS_URL`) |
| `indexer_stopped` | The last cycle is older than 2 × (interval + cycle duration) + 30s |
| `not_indexed` | The indexer is running; this address isn't in its top-N |
| `history_unavailable` | The indexer refreshes it, but its last fetch couldn't read transactions (e.g. no `ETHERSCAN_API_KEY`, a 429) |

The subscription stays open in every case. When a later cycle changes the cause (the address
becomes popular enough, or the Etherscan key starts working), the hub sends a `status` event. A
change in *wording* alone, like a different 429 body each cycle, is not a change.

Subscribing does **not** count as a lookup for popularity. Only real HTTP lookups do. A client
looking at an address has already made one lookup to get the report it's showing.

### 4. Transport: one websocket endpoint on the Explorer's own HTTP server

`ws://<explorer>/stream`, attached through the HTTP server's `upgrade` event (`attachStream` in
`src/stream.ts`). There is no second port, since the stream is the Explorer's own data. It uses
the `ws` npm package (MIT, no service, no API key). Protocol:

```
client → { "subscribe":   { "chain": "ethereum", "address": "0x..." } }
client → { "unsubscribe": { "chain": "ethereum", "address": "0x..." } }
server → { "event": "subscribed", "chain", "address", "live": true }
server → { "event": "subscribed", "chain", "address", "live": false, "cause", "reason" }
server → { "event": "status", ...same shape as subscribed }
server → { "event": "new_transaction", "chain", "address", "transaction": <TransactionSummary>, "detectedAt" }
server → { "event": "possible_gap", "chain", "address", "detectedAt", "message" }
server → { "event": "unsubscribed", "chain", "address" }
server → { "event": "error", "message" }
```

Addresses go through the same `normalizeAddress` as HTTP lookups (Ethereum lowercased), so a
subscription always lands on the key the indexer refreshes. Bounds: 25 subscriptions per
connection, 4 KB max client frame. A 30s ping/pong heartbeat terminates half-open connections.
Every subscription is removed on close or error, and an address with no subscribers left is
dropped entirely, so nothing grows with churn.

### 5. Indexer → server: an event bus, Redis pub/sub when they're separate processes

The documented setup runs the indexer as its own process, sharing Redis with the API server, so
the event has to cross processes. `IndexerEventBus` has two implementations, chosen exactly the
way the cache already is:

- `REDIS_URL` set → `RedisEventBus` (pub/sub on `osstrace:indexer-events`). This is the same Redis
  that's already required for the indexer to be useful, so it's no new infrastructure.
- No `REDIS_URL` → `InMemoryEventBus`. That's only useful when the indexer runs **inside** the API
  process, now possible with `EXPLORER_EMBEDDED_INDEXER=1`. It's the same indexer at the same RPC
  cost. Without either, subscribers are told `no_indexer_cycle` rather than left waiting.

Pub/sub is fire-and-forget. An event published while no API server is listening is lost. That's
acceptable: a push only means something to a client connected at that moment, and a reconnecting
client re-reads current state over HTTP.

## Consequences

- RPC cost of streaming: **zero** new calls. A cycle's adapter calls are identical with or without
  subscribers (asserted in `tests/indexing.test.ts`).
- Lag: a transaction is pushed up to one indexer interval plus one cycle's duration after the
  chain adapter can first see it, plus however far that adapter's own source lags the chain
  (Etherscan's indexing, the Solana RPC's commitment level). This is "pushed when we noticed," not
  block-level real time.
- Coverage is exactly the indexer's top-N. Everything else is honestly reported as not live. A
  per-subscriber watch list, if ever wanted, needs its own design for bounding RPC cost and is not
  implied by this ADR.
- Running two indexers (say, the separate process and an embedded one) against the same Redis
  doubles RPC load and duplicates pushes. Run one.
- Baselines aren't persisted. After an indexer restart, the first cycle re-baselines silently, so a
  transaction landing during the restart window is never pushed (it still shows up over HTTP).
- No auth on the stream. It's read-only public chain data, the same as the open HTTP API. The
  Explorer README's CORS caveat (open by design for local dev) applies here too: before a public
  deployment, add an `Origin` check and per-IP connection limits.
