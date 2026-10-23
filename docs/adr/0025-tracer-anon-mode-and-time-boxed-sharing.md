# ADR 0025 — Tracer local-only (scratch) mode, plus a genuinely separate, time-boxed anon share

Status: Landed, 2026-10-23. Completes the Tracer gap ADR 0024 explicitly left open.

## Context

ADR 0024 gave Explorer and the Visualizer real, uncapped-but-depth-limited access with no account,
by reusing — for the Visualizer — a `localOnly` scratch mode its own `useVisualizerDocument` hook
already had. The Tracer got none of this: `useTraceDocument` always created and dispatched against
a real, signed-in-owned `traces` row, so an anonymous visitor couldn't open the Tracer at all, let
alone build an investigation. ADR 0024's own "What would change this decision" section named the
shape of the fix in advance: compute edge data client-side from the now-anon-accessible
`/api/transfers`/`.../counterparties` endpoints, the same way the Visualizer's scratch mode already
effectively does, rather than depend on the signed-in path's server-side aggregate endpoints.

The operator additionally specified, across several planning turns: anon work lives in browser
memory only, with a warning before it's lost on refresh (not silently); sharing it needs a
genuinely separate mechanism from a signed-in trace's permanent link — a snapshot that expires
after 3 hours, not an on/off toggle on a document that doesn't exist anywhere durable.

## Decision

### 1. `useTraceDocument` takes a `TraceSource` union, mirroring `useVisualizerDocument` exactly

```
type TraceSource = { kind: "scratch"; initial: TraceDoc }
                  | { kind: "saved"; id: string; readOnly: boolean }
                  | { kind: "anonShare"; id: string };
```

`scratch` seeds the shared `OptimisticDocumentStore` with `localOnly: true` and no `dispatch` — the
exact mechanism the Visualizer already uses in production, not a new one. Every edit (`run()` →
`store.beginTransaction()`) still goes through the same code path as a saved trace; it just never
leaves the browser. `TracerPage`'s own id (used for deterministic node-id generation, viewport
storage, etc.) becomes the constant `SCRATCH_ID` for this source, the same role a real trace UUID
plays for a saved one.

`anonShare` is read-only by construction (see §3) — it feeds the store the same way, but with no
`dispatch` either, since a shared snapshot can't be edited.

### 2. Two server-side calls that assumed an owned trace row needed a client-side fallback

`POST /traces/:id/aggregate-summary` and `POST /traces/:id/edges/:edgeId/refresh` both call
`requireUser` + `ownedTrace` — real for a saved trace, meaningless for `SCRATCH_ID`. Rather than
open these specific endpoints to anon callers (there's no trace row to own, so "which trace" has no
answer), `TracerPage.tsx`'s pair-summary panel now computes its own summary from the edges already
in `doc` (`summaryFromTransferEdges`, the exact function `aggregatePairEdit` already used as its own
fallback when no server summary was available) whenever the source is `scratch`, and the
stale-aggregate background refresh effect simply doesn't run for scratch at all — there's no
long-lived document for an aggregate to go stale on in a session that doesn't persist between
visits. Verified live, not just reasoned about: selecting two nodes and clicking "Aggregate" in a
scratch trace produces zero network calls and a correct local summary; the identical flow in a
signed-in trace still calls the real server endpoints exactly as before.

### 3. Anon sharing is a new table and a new pair of routes, not the saved-trace system with a flag

`anon_trace_shares` (new, `packages/server/src/db/migrations/004_anon_trace_shares.sql`): no
`user_id`, a `doc_json` blob (the whole `TraceDoc`, not normalized into `trace_nodes`/`trace_edges`
— there's no undo/redo history or per-field update to support, just a read of exactly what was
submitted), `expires_at = created_at + 3h`. `POST /api/anon-traces` / `GET /api/anon-traces/:id`
take no session at all. A per-IP cap (20 creates/hour) guards the one real abuse surface an
unauthenticated write endpoint has. Expired rows are swept by `pruneAnonTraceShares`, called from
the same hourly `setInterval` in `main.ts` that already prunes sessions and login attempts — no new
cron job.

Frontend: a scratch trace's Share button opens a new `AnonShareDialog` (one-shot "create a 3-hour
link," no on/off toggle — there's no live document to toggle), calling `POST /api/anon-traces` and
showing the resulting `#trace/anon/<id>` URL with its real expiry time. A saved trace's Share button
is untouched — still the original `ShareDialog`, still `PATCH`ing `shareable` on the real trace row.

### 4. `beforeunload` only warns when there's something real to lose

Fires only for `source.kind === "scratch"` with at least one node in `doc`. Not for an empty canvas
(nothing to lose), not for a signed-in session (already autosaves, so there's nothing the warning
would be protecting against).

## What this does not do

- **No indirect-mode anon access.** "Find connections"'s indirect (shared-counterparty) mode stays
  signed-in-only, per ADR 0024's own established pattern for anything beyond a direct read.
- **No cross-session persistence for scratch work.** By design — that's what "local-only" means
  here. A visitor who wants their investigation to survive a refresh needs to connect a wallet
  (autosave) or create a time-boxed share link before leaving.
- **`/api/search`'s 401 for anon callers was not touched** (noticed during verification, not part
  of this decision's scope) — the Tracer's "Add node" dialog's typed-search suggestions don't
  resolve for an anonymous visitor, though pasting an address directly still works (that path
  doesn't call `/api/search` at all). A real but narrow, separately-scoped follow-up.

## Consequences

- `packages/web/src/tracer/useTraceDocument.ts`, `TracerRoute.tsx`, `TracerHome.tsx`,
  `TracerPage.tsx`, `dialogs.tsx`, `api.ts` all changed; `packages/web/src/visualizer/` was not
  touched at all — the shared `optimistic/store.ts`/`useOptimisticDocument.ts` engine needed zero
  changes, confirming it was already general enough for a second consumer.
- New `packages/server/src/services/anonTraceShares.ts`, new routes in `routes/traces.ts`, new
  `anonTraceDoc` schema in `schemas.ts` reusing the existing `traceNode`/`traceEdge` validators.
- Verified live against a real local server end to end: an anon session built a real multi-node
  scratch trace with zero `POST .../batch` calls, correctly saw the Indirect toggle locked, saw
  `beforeunload` go from not-prevented (empty canvas) to prevented (one node added) on the same
  page, created and re-read a real anon share as a genuinely separate, fresh, unauthenticated
  browser context ("View only," real data), and got a clean 404 for a bogus share id. Then, as a
  real signed-in session: autosave, undo, the server-side pair-summary/aggregate path, and the
  permanent public-share toggle were each independently re-confirmed still firing their real
  endpoints exactly as before — the regression check that matters most for this change, since it
  touches a hook every Tracer session depends on.

## What would change this decision

- **Real demand for scratch work to survive a refresh without signing in** would need either
  `localStorage` persistence (same per-browser, not-shared-across-devices tradeoff this project
  already uses for theme/motion preferences) or shortening the gap by making the share-link flow
  more prominent — not built, no evidence of the need yet.
- **The `/api/search` anon gap** (see above) would be a small, separate follow-up: widen it the same
  way §1 of ADR 0024 widened the address/balances/transfers/counterparties routes.
