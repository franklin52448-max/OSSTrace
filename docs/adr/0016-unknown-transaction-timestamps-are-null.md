# ADR 0016 — An unknown transaction timestamp is `null`, never a made-up date

Status: Decided 2026-10-22 (implemented in `packages/core`, `packages/chains/solana`,
`packages/features/{visualizer,tracer,explorer}` and `packages/web`)

## Context

`TransactionSummary.timestamp` was typed `string`. Every adapter had to produce one, including
when the chain hadn't said when a transaction happened.

That case is real on Solana. `getSignaturesForAddress` returns `blockTime: null` for some very
recent signatures. The Solana adapter handled that with
`new Date(0).toISOString()`, so the transaction came out dated `1970-01-01T00:00:00.000Z`. That is
a made-up date on a real transaction, which this project doesn't allow anywhere else (labels need
a cited source, ADR 0002; unresolved token fields are `null`, never guessed). It also did quiet
damage further down:

- The Tracer's `until` filter passed every one of these edges, because 1970 is before any
  `until` date. `since` failed them, but only because 1970 happened to be early.
- The Tracer's `breadth` ranking (ADR 0008) put them last, but only because 1970 is old.
- The UI printed "1/1/1970" next to a real transaction.

The type was the root cause. With `timestamp: string`, "I don't know" couldn't be written down.

## Decision

`TransactionSummary.timestamp` is `string | null`. `null` means the chain adapter doesn't know
when the transaction happened. An adapter must never fill it in with the epoch, "now", or any
other default.

- **Solana** uses `getSignaturesForAddress`'s `blockTime`. When that is null it uses the fetched
  transaction's own `blockTime` (real chain data from the same RPC). When both are null,
  `timestamp` is `null`.
- **Ethereum** is unchanged. Etherscan always reports a real `timeStamp`, so it never produces
  `null`. The type is nullable for every chain anyway, so consumers can't assume otherwise.
- Visualizer's `GraphEdge.timestamp` and `OmittedTransaction.timestamp` carry the same
  `string | null` through. A Tracer `BridgeEdge.timestamp` stays `string`: Wormholescan operations
  without a source timestamp are already counted and dropped (ADR 0012), so that one is always real.

What `null` means for each consumer:

### Filtering (`since` / `until`)

An edge with `timestamp: null` **fails** any `sinceTimestamp` or `untilTimestamp` filter. Nobody
can show it falls inside the window, so it doesn't count as matching. This is the same rule ADR
0012 already uses for a bridge edge with an unresolved symbol or amount: unknown fails the filter,
it never passes by default. `edgeMatchesFilters` checks for `null` in its own branch. It doesn't
leave it to a `NaN` comparison, which would pass or fail depending on which way the comparison is
written. An edge with no time filter applied is unaffected: an undated transaction is still a real
hop.

### `breadth` ranking

A neighbour reached only through undated edges ranks **after** every neighbour with a real
timestamp. Its sort key is `-Infinity`. A neighbour with both dated and undated edges is ranked by
its latest dated one. The comparator never sees `NaN`, which would make `Array.prototype.sort`'s
order unpredictable. When several neighbours tie, including when every edge is undated, they keep
the order they were first seen in, because `sort` is stable.

### Real-time diffing (Explorer, ADR 0013)

`diffTransactions` works out where the previous fetch's window ended from its **dated** entries
only. Before, a single undated entry made that minimum `NaN` and switched the end-of-window check
off without saying so. An unseen undated transaction in a full window still can't be shown to be
newer than the window's end, so, as the module already documented, it isn't reported. New
transactions are sorted oldest first, with undated ones after every dated one.

### Display

The UI shows **"time unknown"** for a `null` timestamp. It never passes `null` to `new Date(...)`,
because `new Date(null)` is the Unix epoch and would print 1970 all over again. The web package's
`formatTimestamp` (`src/timeDisplay.ts`) is the single place that decides this. The Lookup, Graph
and Tracer views all use it.

## Consequences

- Every consumer of `TransactionSummary.timestamp` has to handle `null`. Because of the type
  change, a consumer that doesn't won't compile (`Date.parse(null)` is a type error).
- An honest `until` filter now returns fewer edges than before for Solana addresses with very
  recent activity: the undated edges used to pass because of the fake 1970. That is the
  intended behaviour.
- In the Explorer's live stream, a transaction that is undated when the indexer first sees it in
  a full window is not pushed as new, and won't be pushed later either, once it is dated, since by
  then its hash is in the previous fetch. That is the price of never calling something "new" that
  can't be shown to be. It can be revisited in the indexer if it turns out to matter.
- The web package keeps its own copies of the API response types. They now say
  `timestamp: string | null` as well.
