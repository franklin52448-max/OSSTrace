# ADR 0022 — A single unified server replaces the per-feature microservices

Status: Largely landed, 2026-10-22. `packages/contract` and `packages/server` exist and are what
the live site actually runs on. Explorer, Visualizer and Tracer are now wired to the new server
(no longer the nine old per-feature services for anything reachable from the live nav). Auth was
rebuilt on wallet sign-in rather than carried over from the old accounts service — see
[ADR 0023](0023-wallet-sign-in-replaces-accounts-and-moderation.md), which also covers why
Confirmed-tier/community label moderation was dropped rather than ported. Bounties (ADR 0020) was
ported onto `packages/server` too. Cases was retired from the nav rather than ported (the canvas
was always its intended replacement, per §"What this chunk does not do" below; retiring it turned
out to be simpler than finishing that port). The **Workbench** tab mentioned in this ADR's earlier
drafts was the scratch page used to prove the server connection before any of the above landed;
it's deleted now that Explorer does everything it did. The nine old `packages/features/*` packages
are not deleted — see this ADR's own Consequences below for which are still genuinely needed and
why.

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

### 6. Real CORS, added once something actually needed it: a cookie session, cross-origin

The server's own original frontend reached it through a same-origin Vite dev-server proxy, so it
was never built to answer a genuinely cross-origin browser request — `app.ts`'s only Origin
handling was the CSRF check (refuse a mutating request from an unlisted Origin), never the
`Access-Control-Allow-Origin`/`-Credentials` response headers a browser requires before it will
even send (let alone let the page read) a cookie-carried session across origins, and there was no
preflight `OPTIONS` handling at all (it fell through to the 404 handler). `packages/web` calls
this server directly, cross-origin, exactly like it already calls the nine old services — so this
had to be added for the Workbench wiring (§ below) to work at all, not optional polish. Reuses the
same `ALLOWED_ORIGINS` allowlist the CSRF check already has; never reflects a disallowed origin,
never `*` (a credentialed response can't use `*` by spec anyway). See `tests/cors.test.ts`.

### 7. Workbench: the first thing actually wired to it

`packages/web` gets a new nav tab, **Workbench** (`src/WorkbenchView.tsx`), not a replacement of
Explorer/Visualizer/Tracer but genuinely additive next to them. It has its own session
(`src/serverSession.ts`) — a cookie, not a bearer token like `session.ts`'s (the old accounts
API's) — because the two backends authenticate completely differently; a visitor may need to be
signed in to both during the migration, which is expected and temporary, not a bug. Signing up,
logging in, and looking up a real address (balances sorted and capped to the top 20 by USD value —
a busy wallet can hold hundreds of mostly-spam tokens, so showing all of them isn't usable; recent
transfers with an honest `sync` status chip when the server hasn't finished covering an address)
all go through the real server, verified against real on-chain data via headless Chromium, not
just curl. `packages/server/tests/cors.test.ts` and `packages/web/tests/serverSession.test.ts`
cover the auth/CORS plumbing; `WorkbenchView.tsx` itself has no automated DOM-level test yet, since
its balances/transfers fetch needs either a live network call or a fake chain provider
`@osstrace/server` doesn't currently expose publicly — see `packages/web/README.md`'s Tests section
for the honest account of what is and isn't covered, including why a session surviving a page
reload could only be verified in a real browser (Node's own `fetch`, what the `node --test` harness
uses, has no cookie jar at all).

## What this chunk does not do

Updated 2026-10-22 against what's actually landed; struck-through items are done, the rest is
still accurate.

- ~~Explorer/Visualizer/Tracer themselves are not wired yet.~~ Done — all three now run on
  `packages/server`. Tracer specifically became a real investigation canvas (place addresses,
  connect them, autosave/undo/redo, share read-only), not a straight swap of the old path-search
  page.
- **The old multi-hop path-finding/cross-chain (Wormhole) tracer (`TracerView.tsx`) is kept
  reachable at `#pathfind/<chain>/<address>`, off the main nav, rather than ported into the
  canvas yet** — the canvas doesn't have an equivalent auto-search action. Folding it in is still
  future work; it's not lost, just not unified yet.
- ~~No roles/moderation... community submission + moderation... get built on top of this
  foundation.~~ Reversed, not just delayed: see ADR 0023. Roles and the Community/Confirmed
  moderation pipeline were not ported, and the new auth model (wallet sign-in) has no natural
  "moderator" concept to build one on top of. The ingested sanctions/protocol labelset, risk
  scoring and bounty funding (ADR 0020) *were* built on this foundation, each as planned here.
- ~~Cases is not ported.~~ Retired instead of ported — removed from the nav and home page rather
  than rebuilt as a canvas feature. `packages/features/case-management` is kept only for
  `casesView.test.ts`'s retired-component coverage (see Consequences).
- **No real-time (websocket push).** Still true — the new server only polls.
- ~~The nine old services are not retired yet.~~ Partially: none of the nine are reachable from
  the live site's navigation anymore, but none are literally deleted either — see Consequences for
  which are still genuinely needed (test coverage, or `#pathfind`) versus just not yet cleaned up.

## Consequences

- A second test runner (vitest) now exists in this repo, scoped to exactly two packages, for the
  reason given in §4 — a deliberate, documented exception to the project's usual `node --test`
  convention, not a drift nobody decided on.
- Two "shared types" packages exist for a while (`packages/core` for the old architecture,
  `packages/contract` for the new one) until the cutover chunk retires the old services that still
  depend on `packages/core`.
- **The nine old `packages/features/*` packages are still in the repo, and that's deliberate, not
  neglect** — but for two different reasons depending on the package: `tracer` is still genuinely
  live, behind the `#pathfind` route described above. `accounts`, `community-labels`,
  `private-labels`, `explorer`, `visualizer` and `case-management` are kept running only because
  specific tests (`lookupRace.test.ts`, `graphView.test.ts`, `casesView.test.ts`, and similar)
  deliberately exercise retired web components (`Lookup`, `GraphView`, `CasesView` in
  `packages/web/src/`) against them, for real test coverage of functionality the new server
  doesn't reproduce yet (sanctions tags, live transaction streaming, private labels, moderation
  review UI). None of the nine are reachable from the live site's own navigation. `risk-scoring`
  is the one exception with no current consumer at all (its `RiskPanel.tsx` is only rendered from
  inside the retired `Lookup`/`Report` chain) — a candidate for outright deletion if nothing comes
  to depend on it, not yet acted on here.
