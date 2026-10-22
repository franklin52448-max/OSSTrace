# ADR 0014 — A failed balance call is reported, not allowed to hide the rest of the report

Status: Decided 2026-10-22 (implemented in `packages/core/src/types.ts`, `packages/features/explorer/`
and `packages/web/src/App.tsx`)

## Context

`lookupAddress` built an `AddressReport` with one `Promise.all` over five calls: the chain
adapter's `getBalance` and `getRecentTransactions`, and the label store's label, tags and entity.
`Promise.all` rejects as soon as any one of them rejects. `getBalance` throws when its RPC is down
or rate-limited, so one failed balance call made the whole request a `502`. The caller lost:

- the transaction history, which is a separate call to a separate service on Ethereum (Etherscan,
  not the JSON-RPC node) and may well have succeeded;
- the label, tags and entity, which are local reads with nothing to do with the RPC at all.

The label is the part that matters most. "This address is on the OFAC SDN list" is exactly the
answer someone came for, it was sitting on local disk, and an upstream outage hid it.

Transaction history already had the right model. `TransactionsResult` is
`{ available: true, transactions } | { available: false, reason }`, so "we couldn't check" is a
value with a reason, never an exception and never an empty list that looks like "nothing there".

## Decision

1. `@osstrace/core` gets `BalanceResult`, the same shape:
   `{ available: true; balance: Balance } | { available: false; reason: string }`.
2. `AddressReport.balance` is a `BalanceResult`. This is a breaking change to the Explorer's JSON:
   the balance now sits one level down, at `balance.balance`.
3. `lookupAddress` runs the two chain calls independently. A `getBalance` throw becomes
   `balance: { available: false, reason }`. A `getRecentTransactions` throw, which the adapter
   contract already says shouldn't happen, becomes `transactions: { available: false, reason }`
   in the same way, so neither can take the other down. Only a label-store failure still rejects
   the whole lookup. That's a local read; if it fails, something is wrong with this deployment and
   not with a chain.
4. `ChainAdapter.getBalance` keeps returning a plain `Balance` and throwing on failure. The
   orchestrator turns the throw into a result. Changing the adapter interface would touch every
   chain package and every adapter wrapper for no gain: there's exactly one place that needs the
   failure as a value.
5. A report whose balance is unavailable is not cached, by the API server or by the background
   indexer. Before this change the failure was a throw, so nothing got cached and the next lookup
   retried at once. Caching it would keep showing "unavailable" for the full TTL after the RPC
   came back. Its transactions are still diffed by the indexer for live pushes (ADR 0013), since
   they came back fine on their own.

## Consequences

- The Explorer answers `200` with whatever it could get. A `502` now means the lookup as a whole
  failed, not that one upstream call did.
- The web UI shows "Unavailable — <reason>" in the balance card and keeps rendering the label,
  tags and transactions. Transaction amounts take their unit (ETH/SOL) from the chain, not from the
  balance, so they still render when the balance didn't come back.
- Any other client of the Explorer API has to read `balance.available` before
  `balance.balance.native`. In this repo the only one was `packages/web`. The Visualizer, Tracer
  and Risk Scoring call the chain adapters directly and never read `AddressReport.balance`.

## Alternatives considered

- **Keep `balance: Balance | null` and add a `balanceError` field.** That's two fields that can
  disagree, and a `null` a client can mistake for "zero". The tagged union can't be misread, and
  it matches `TransactionsResult`, so clients handle both the same way.
- **Retry the balance call before giving up.** Doesn't solve the problem. An outage outlasts any
  sensible retry, and the request still has to answer with what it has.
