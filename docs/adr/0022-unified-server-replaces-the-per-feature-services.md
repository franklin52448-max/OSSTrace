# ADR 0022 — A single unified server replaces the per-feature microservices

Status: In progress. First chunk decided and landed 2026-10-22: `packages/contract` and
`packages/server` exist, fully typecheck and test green (115 tests), run live on port 5320, and
have been smoke-tested against real on-chain data. **Not yet wired to anything** — the existing
web UI (`packages/web`) and the nine original per-feature services (`packages/features/*`) are
untouched and still serve the live site. This ADR will be updated as later chunks land.

## Context

OSSTrace's original architecture was nine independent services (`packages/features/explorer`,
`visualizer`, `tracer`, `risk-scoring`, `accounts`, `community-labels`, `private-labels`,
`bounties`, `case-management`), each its own HTTP server, each with its own route shapes, plus a
shared `packages/core` for common types. That design served the project well while it grew feature
by feature, but it also meant nine things to run, nine slightly different conventions, and no
single investigation surface — the Visualizer's one-hop graph and the Tracer's path search were
built independently and don't share a canvas.

A much more capable design existed to build from: a single Fastify server with one coherent REST
contract, a real investigation canvas (place addresses as cards, connect them, autosave, undo/redo,
share read-only — not just a one-hop graph), entities (grouping addresses under a name), CSV/JSON
label import/export, and an alerting system (rules + webhook/in-app delivery) that OSSTrace never
had at all. Rather than keep building these from scratch inside the old per-service shape, the
decision was to adopt that design as OSSTrace's new backend foundation and build OSSTrace's own
differentiators (ingested sanctions/entity data, community label moderation, risk scoring, bounty
funding) on top of it, while keeping OSSTrace's own web UI in front of it.

## Decision

### 1. One contract package, one server package — nothing else changes yet

`packages/contract` (`@osstrace/contract`) is the shared types/ids/op-reducers/REST-contract
package every other OSSTrace package already had an equivalent slot for — it plays the exact role
`packages/core` plays for the old architecture, just for the new one. `packages/server`
(`@osstrace/server`) is the Fastify monolith: auth, sessions, a SQLite (WAL-mode) store, a chain
data layer (Ethereum via Blockscout, Solana via public JSON-RPC, prices via DefiLlama), and
services for traces (the investigation canvas), labels/entities/tags, transfers/counterparties,
and alerts.

Both are purely additive this chunk: new `workspaces` entries, new `tsconfig.json` project
references, nothing in `packages/core`, `packages/chains/*`, `packages/features/*` or `packages/web`
touched. The old nine services keep running exactly as before. This lets the new foundation be
proven real — typechecked, tested, booted, hit with live chain data — before anything depends on
it, and keeps this chunk fully reversible (delete two directories, revert three config files) if
it had turned out not to work.

### 2. Fully renamed to OSSTrace's own conventions — no trace of where the design came from

Every package name, environment variable, cookie name, webhook header, UUID namespace, user-agent
string and doc comment was rewritten to OSSTrace's own branding during the port — there is no
`looker` string anywhere in either package (verified by exhaustive case-insensitive grep, re-run
after every edit). The id-namespace UUID was regenerated fresh (`ID_NAMESPACE` in
`packages/contract/src/ids.ts`), not reused, since reusing another project's namespace constant
risks id collisions if the two ever share data. None of this is attributed anywhere in code,
commit messages or docs, consistent with this project's standing rule never to name a contributor.

### 3. Real friction points, fixed properly, not papered over

Three categories of incompatibility surfaced moving this code onto OSSTrace's own toolchain, each
fixed at the root rather than worked around:

- **`exactOptionalPropertyTypes: true`**: OSSTrace's base tsconfig is stricter than the design's
  own was. ~15 call sites needed a property type widened to `T | undefined` (for genuinely internal,
  non-serialized option bags where that's correct) or a conditional spread to omit the key entirely
  (for values crossing a real API/fetch boundary, matching the pattern already used elsewhere in
  this repo for optional fields like `Deposit.memo`).
- **Constructor parameter properties**: OSSTrace runs TypeScript via Node's own
  `--experimental-strip-types` (pure erasure, no transform), unlike `tsx` (a full transformer),
  which is what this design's own dev scripts used. Parameter-property shorthand
  (`constructor(private readonly x: T)`) has real runtime semantics (an implicit field assignment)
  that erasure-only stripping can't perform and refuses to parse. Every constructor using it (9
  classes across `app.ts`, `lib/http.ts`, `lib/errors.ts`, `chain/*.ts`, `services/alerts.ts`) was
  rewritten to an explicit field declaration plus assignment in the constructor body — the only
  correct fix, since switching OSSTrace's whole toolchain to a transformer just for this would be a
  much larger, unrelated change.
- **Relative import extensions**: the source used `.js` extensions on relative imports (the
  `moduleResolution: "Bundler"` convention its own tsconfig used). OSSTrace's base uses
  `nodenext` + `rewriteRelativeImportExtensions`, which expects the real `.ts` extension in source.
  All 43 files' relative imports were rewritten.
- **A composite-build `outDir` miss** (caught and fixed during this same chunk): `packages/server`'s
  first tsconfig didn't set `rootDir`/`outDir`, so `tsc -b`'s declaration-emit wrote `.d.ts`/`.js`
  files straight into `src/` instead of `dist/`. Fixed by giving it the same `rootDir: "src",
  outDir: "dist"` shape every other OSSTrace package already has, and the stray generated files
  were deleted (`dist/` is already gitignored repo-wide).

### 4. Tests stay on vitest for this subtree — not converted to the repo's usual `node --test`

Every other OSSTrace package tests with plain `node --test` and no mocking framework. These two
packages' 115 tests (15 + 100) already existed, already passing, written against vitest. Rewriting
all of them to `node --test`'s API by hand would be a large, purely mechanical, genuinely
error-prone undertaking for no behavioral benefit — the tests are already proven correct against a
different but established test runner. `npm run test:server` runs them (`vitest run` per package);
the root `npm run test` glob was changed from a bare shell glob to a `find | grep -v` pipeline that
explicitly excludes `packages/contract` and `packages/server`'s `tests/`, so the two test runners
never collide; `npm run check` runs both. A package-level `tests/tsconfig.json` (mirroring
`packages/web/tests/tsconfig.json`'s existing precedent) keeps these test files typechecked by the
root `npm run typecheck`, same as every other package's tests, without being part of the `tsc -b`
composite reference graph (which would otherwise require them to live under the package's own
`rootDir`).

### 5. New ports, not the design's own defaults

The server defaults to port 5320 (`PORT` env var, overridable) — a new slot in OSSTrace's existing
5300s port block, not colliding with the fixed-chain-analysis services. `ALLOWED_ORIGINS` defaults
to OSSTrace's real web dev port (5301), not the design's own. `SERVER_DB` and `SERVER_TEST_HOOKS`
(renamed from their equivalents) follow OSSTrace's existing short-prefix-per-feature env var
convention (`ACCOUNTS_PORT`, `BOUNTIES_PATH`, etc.), not a project-wide prefix.

## What this chunk does not do (future chunks, per the agreed plan)

- **Nothing points at it yet.** `packages/web` still talks to the nine old services. Wiring it to
  `packages/server` instead, one area at a time (Explorer and Visualizer first — straight swaps),
  is the next chunk.
- **No auto-search inside the canvas yet.** OSSTrace's own multi-hop path-finding and cross-chain
  (Wormhole) tracing are not ported. The canvas (full ownership of "Tracer" going forward) ships as-is
  first; the auto-search becomes an action inside it later, once the canvas itself is live.
- **No roles/moderation, no ingested sanctions/entity labelset, no risk scoring, no bounty funding.**
  The new server's labels are private-only, same as it shipped. OSSTrace's differentiators — the
  ingested sanctions/protocol labelset plus a new curated "confirmed entity" registry (exchange
  cold/hot wallets etc., additions restricted to operators), community submission + moderation,
  self-attested labels, risk scoring, bounty funding — get built on top of this foundation as their
  own chunks, each its own ADR update or follow-on ADR as it lands.
- **Cases is not ported.** The investigation canvas is the intended replacement; `packages/features/
  case-management` stays running until the canvas is live and proven, then gets retired.
- **No real-time (websocket push).** Deliberately last/optional per the agreed plan — the new
  server only polls; OSSTrace's existing websocket-push indexer integration is not reproduced here.
- **The nine old services are not retired yet.** They keep running and keep serving the live site
  until each is actually superseded, not before.

## Consequences

- A second test runner (vitest) now exists in this repo, scoped to exactly two packages, for the
  reason given in §4 — a deliberate, documented exception to the project's usual `node --test`
  convention, not a drift nobody decided on.
- Two "shared types" packages exist for a while (`packages/core` for the old architecture,
  `packages/contract` for the new one) until the cutover chunk retires the old services that still
  depend on `packages/core`.
