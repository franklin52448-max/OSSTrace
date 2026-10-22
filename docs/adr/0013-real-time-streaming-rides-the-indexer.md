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
client → { "auth":        { "token": "ots_..." } }      (first message; added in §6)
server → { "event": "authenticated" }
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

### 6. Who may connect: Origin allowlist, per-IP cap, then an accounts session (added 2026-10-22)

The first version shipped with no auth, no `Origin` check and no connection limit, and said so.
These three were added before any public deployment. This is a section of this ADR rather than a
new one: it changes who may open the stream, not how pushes are produced or what they cost, and
every rule in §1–§5 stands unchanged. The gates run in this order, cheapest first.

**6.1 `Origin` allowlist, checked on the upgrade request.** A browser always sends `Origin` on a
websocket upgrade, and websockets aren't covered by CORS, so without this check any web page a
user visits could open the stream from their browser (cross-site websocket hijacking). An `Origin`
that isn't in the list gets an HTTP `403` and the websocket is never created. The list is exact
string matches, the same pattern `@osstrace/accounts` uses for CORS: `EXPLORER_STREAM_ALLOWED_ORIGINS`,
falling back to `ACCOUNTS_ALLOWED_ORIGINS` (as the bounties server does), then
`http://localhost:5301`. The literal origin `null` (sandboxed iframes, `file://`) is refused
unless someone lists it.

An upgrade with **no** `Origin` header is **allowed**. This matches the accounts package, which
never refuses a request for lacking `Origin` (its allowlist only decides which browsers get CORS
headers). It's also right for this endpoint on its own terms: the header's only job is to say
which page a browser is acting for. A request without it comes from a script, a bot or a server,
which is a normal consumer of a public read-only API, and which could put any value in the header
anyway. Refusing it would block legitimate clients and stop no one. Those clients still have to
pass 6.2 and 6.3.

**6.2 At most 8 concurrent connections per remote address** (`MAX_CONNECTIONS_PER_IP`), counted in
`StreamHub` on `req.socket.remoteAddress` (IPv4-mapped IPv6 folded to IPv4). Every open socket
counts, authenticated or not, so one address can never hold more than 8 sockets waiting on the
10s auth timeout, or more than 8 × 25 = 200 subscriptions. Over the cap, the new connection gets
an `error` event and a close with code `1013` (try again later). An existing connection is never
evicted to make room, since that would let a newcomer knock off someone already watching.

Why 8: the web UI opens one socket per address report on screen, so a single person with a few
tabs open needs several. A small office or household behind one NAT shares one address. Memory per
idle socket is small, and the cap is about keeping one actor from multiplying itself, not about
rationing normal use. 5 would already pinch a person with a handful of tabs. More than about 10
starts to make a single address's ceiling (subscriptions, auth-pending sockets) large for no real
user's benefit.

The over-cap connection completes the websocket handshake and is then closed, instead of being
refused with a `429` at the HTTP level. That costs one handshake, but a browser's `WebSocket` API
can't see an HTTP status on a failed upgrade, while it does see the close code and reason.

**Known limit, not solved here:** behind a reverse proxy, `remoteAddress` is the proxy, so every
client would share one cap. `X-Forwarded-For` is deliberately not read. Any client can send that
header, and trusting it unconditionally would let anyone dodge the cap by making up a new address
on each connection. A proxied deployment needs trusted-proxy handling (honor the header only when
the TCP peer is a configured proxy), which is future work.

**6.3 A session from `@osstrace/accounts`, sent as the first message.** There's no second auth
system: the hub takes anything with `AccountService.authenticate()` (in the server, the real
service on the same accounts file, so a token from `POST /accounts/login` works here). The first
client message must be `{ "auth": { "token": "ots_..." } }`. The hub answers
`{ "event": "authenticated" }`, then handles subscribes. A first message that isn't `auth`, a
token that's invalid, expired or logged out, or no `auth` within 10s each get an `error` event and
a close with code `1008` (policy violation). The web UI treats `1008` as "don't retry with this
token". Subscribes sent right behind the `auth` message, without waiting for the ack, are queued
(up to 30) and handled in order once the session checks out, so a client doesn't need an extra
round trip.

Why the first message and not `?token=` on the URL: the browser `WebSocket` API can't set an
`Authorization` header, and a token in a query string ends up in access logs, proxy logs and
browser history. In a frame, it's handled exactly like the `Authorization: Bearer` header every
other API here uses.

Why require a session rather than allow anonymous connections with a tighter limit: the earlier
line in Consequences ("no auth on the stream... read-only public chain data") explained why the
first version could ship without auth. It didn't say anonymous access was a goal, and the README's
own list of what to add before a public deployment included auth. Requiring a session is the
simpler rule: one path, no second tier of limits to tune. It also lets the web UI identify itself
on a public server. The HTTP API stays open, because a one-shot request costs the server nothing
once it's answered, while a websocket is a resource someone holds open indefinitely.

To be clear about what this does and doesn't do: signups are free, so auth gives accountability
and identification, but it isn't flood protection by itself. The per-IP cap in 6.2 is the flood
protection. There's no per-account connection cap.

The session is checked once, at connect. A logout or expiry doesn't close a stream that's already
open; the next connection with that token is refused. Re-checking on every heartbeat would mean an
accounts-file read per socket every 30s, which isn't worth it for read-only public data.

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
- ~~No auth on the stream.~~ Superseded by §6: the stream now requires an accounts session, an
  allowed `Origin` (or none), and stays within 8 connections per remote address. Live updates in
  the web UI therefore need a signed-in user; the HTTP report doesn't. Behind a reverse proxy the
  per-IP cap needs trusted-proxy handling that isn't built (§6.2).
