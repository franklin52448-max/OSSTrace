# ADR 0024 — Anon mode: real Explorer/Visualizer access without an account, capped; full access and saving need a wallet

Status: Partially landed, 2026-10-23. Explorer and the Visualizer's existing scratch mode work
signed-out today, real data, with a depth cap. The Tracer's own scratch/local mode (the deeper
part of this decision) is not built yet — see "What this does not do."

## Context

Every read in `packages/server` required a signed-in session (`requireUser`), inherited unchanged
from ADR 0023's wallet-auth rewrite — auth got simpler, but nothing revisited whether every route
*needed* to be behind it. In practice this meant Explorer, the Visualizer and the Tracer were all
unusable without connecting a wallet first, even for a one-off "what does this address hold"
lookup — exactly the kind of quick check this project's own pitch (open, friction-free on-chain
intelligence) says it should support.

The decision, made directly by the operator across several planning turns: real access without an
account for the lookup/investigation features, capped so it can't be used to extract a busy
wallet's entire history for free; full depth and everything that needs to persist (saving,
sharing, entities, labels, alerts, bounties) stays behind connecting a wallet.

## Decision

### 1. Explorer, Visualizer and Tracer data reads no longer require a session

`packages/server/src/routes/chain.ts`'s `/api/address/:chain/:address`, `.../balances`,
`.../counterparties`, and `/api/transfers` now read `req.user?.id ?? null` instead of calling
`requireUser`. `LabelIndex.load` already handled a `null` owner (returns no labels, confirmed by
reading it rather than assumed); `queryTransfers`/`counterpartiesFor`/`parseAddrRef` were widened
to accept `string | null` the same way. An anon caller referencing `entity:<id>` is rejected with
a clear 400 ("Sign in to use a saved entity") rather than silently returning nothing — entities are
private account data by construction, there's nothing to expand for someone with no account.

**Not touched, deliberately**: Alerts, Labels (as a saved/private feature — the public ingested
labels like OFAC still show up via the above, since `LabelIndex` only withholds *private* ones),
and Bounties posting/backing/claiming. Nothing meaningful exists for an anonymous visitor to do on
any of those — watching an address needs somewhere to notify, a private label needs an owner, a
bounty needs a payer. `/api/chains` and `/api/search` also stay signed-in-only: chain status is a
minor endpoint with no anon consumer, and search's own meaningful hits (your labels, your
entities) are account data — the homepage's address search doesn't call it at all (it detects the
chain client-side and navigates straight to the address page, which is now anon-accessible).

### 2. Anon access is capped at 100,000 transactions per address (`ANON_TX_CAP`)

Enforced server-side in `services/transfers.ts`'s `syncAll`, not just hinted at by the frontend —
before syncing an address for an anon caller, `countStored()` checks how many transfers are
already cached for it; once an address is at or over the cap, further syncing for it is skipped
entirely (no more provider/RPC spend on behalf of someone with no account) and the response's
`sync.anonCapped` flag is set (`SyncStatus.anonCapped`, new in `@osstrace/contract`). A
signed-in caller never has this check applied at all — not a higher cap, no cap. This can't be
bypassed by calling the API directly: the check keys off the server's own count of already-synced
data for that specific address, not anything the client sends.

The frontend side of surfacing `anonCapped` nicely (today it's a flag a caller can check, not yet
wired into a "connect a wallet to see full history" UI treatment) is left for a follow-up — the
server contract exists and is tested; the exact anon-mode prompt copy/placement is a frontend
task, not blocking this ADR.

### 3. The Visualizer's existing "scratch" mode already covers Visualizer anon access

Not something built for this decision — `useVisualizerDocument`'s `localOnly: !saved` mode
already existed (the homepage's own copy already describes it: "a scratch graph lives in the
URL"), and the Visualizer's home page already routes a fresh lookup into `#graph/scratch?...`
with no server call for the graph structure itself, only for the underlying address data (now
anon-accessible per §1). Once §1 landed, the Visualizer's anon path worked with no further
Visualizer-specific change. Verified: `VisualizerHome`'s own "saved views" sidebar call
(`GET /api/views`, inherently account-only — nothing to list for someone with no account) is now
`enabled: signedIn` instead of firing and 401ing; `DocList` gained a `signedOut` state ("Connect a
wallet to save views and come back to them later") instead of showing a load error or spinning
forever. `TracerHome` got the same treatment for its own trace list, for the same reason.

### 4. Signed-in users were already effectively uncapped; confirmed, not changed

There was no existing hard ceiling on sync depth for ANY caller before this — only the per-request
time budget (`budgetMs`, default 12s) that already produces the progressive "partial, loads more
on later requests" behavior described in ADR 0022's own context. §2's cap is additive for anon
only; a signed-in caller's experience (slow progressive loading for a very deep history, no
artificial stop) is unchanged by this ADR. A real fix for *slow* (not capped) deep Solana history —
an indexed API instead of the current N+1 raw-RPC-per-transaction pattern — is a known, separate,
not-yet-started follow-up (blocked on acquiring a Solscan API key), noted here so it isn't
confused with what this ADR covers.

## What this does not do

- **No Tracer scratch/local mode yet.** Unlike the Visualizer, the Tracer's `useTraceDocument`
  always creates and dispatches against a real, persisted, signed-in-owned `traces` row
  (`POST /api/traces`, `POST /api/traces/:id/batch`, and critically the aggregate-summary/
  edge-refresh endpoints that compute edge data server-side against an owned trace). Giving the
  Tracer the same `localOnly` scratch mode the Visualizer already has — needed for an anon visitor
  to actually build an investigation, not just look up single addresses — requires touching
  `TracerPage.tsx`'s edge-aggregate computation path in a way that wasn't safely verifiable in the
  time available for this change, and risking that working, signed-in-only-tested code felt like
  the wrong tradeoff against shipping a real but narrower anon mode now. `TracerHome`'s "start a
  trace" action was changed only enough to fail cleanly ("Connect a wallet to start a saved
  trace.") instead of a raw 401, rather than attempt the rewrite.
- **No anon-specific 3-hour-expiring share link.** Depends on Tracer scratch mode existing first —
  nothing to share without a trace document. Not built.
- **No `beforeunload` "you'll lose this" warning.** Same dependency — there's no anon trace-editing
  state yet to warn about losing.
- **No frontend UI treatment for `anonCapped` beyond the raw API flag** (§2).

All four are real, were explicitly asked for, and are not done — this ADR's status line says
"partially landed" rather than "done" on purpose. The honest state: anonymous visitors can now
look up any address and browse Visualizer graphs with real data, capped at real volume; they
cannot yet build or share a Tracer investigation without connecting a wallet.

## Consequences

- `SyncStatus` (the `@osstrace/contract` type shared by the Explorer, Visualizer and Tracer's
  sync-status UI) gained an optional `anonCapped` field — additive, no existing consumer needed to
  change.
- `parseAddrRef`, `queryTransfers`, `counterpartiesFor` all now take `userId: string | null`
  instead of `string` — a real, if mechanical, widening of the service layer's auth assumption
  that any future route built on these functions needs to keep in mind (an anon `null` is a real,
  expected case now, not an error state).
- New test coverage (`packages/server/tests/anonAccess.test.ts`): anon reads succeed with no
  session, anon never sees another user's private labels, the `entity:` ref rejection, the cap
  triggering past `ANON_TX_CAP` and not triggering under it, and that a signed-in caller is never
  capped.

## What would change this decision

- **Building the Tracer's scratch mode** (the biggest open item above) would need its own careful
  look at how `computeAggregate`/edge-refresh should work without a persisted trace row — probably
  computing edge aggregates client-side from the now-anon-accessible `/api/transfers` /
  `.../counterparties` directly, mirroring what the Visualizer's scratch mode already effectively
  does, rather than reusing the signed-in path's server-side aggregate endpoints at all.
- **Real abuse of the 100k cap** (e.g., many anon sessions each individually staying just under it
  across many different addresses) would need a broader per-IP or per-session budget on top of the
  per-address cap this ADR adds — not built, because no evidence of it yet; the per-address cap
  was the specific, confirmed ask.
