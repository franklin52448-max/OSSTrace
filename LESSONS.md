# Lessons

- **Node's `--experimental-strip-types` needs literal `.ts` extensions in relative imports** —
  it doesn't rewrite `.js` to `.ts` at resolution time. Fixed by enabling both
  `allowImportingTsExtensions` and `rewriteRelativeImportExtensions` in `tsconfig.base.json`,
  writing `.ts` extensions everywhere, and letting `tsc -b` rewrite them to `.js` on real emit.
  This is what lets every package run directly via `node --experimental-strip-types src/foo.ts`
  with zero build step, while still compiling cleanly with `tsc -b` when a real `dist/` is needed.
- **Node's strip-only type-stripping mode can't handle TypeScript "parameter properties"**
  (`constructor(private readonly x: Foo)`) — that shorthand has real JS semantics (it declares
  *and* assigns a field), not just type annotations, so strip-only mode rejects it outright.
  Always declare fields explicitly and assign them in the constructor body instead.
- **`find -maxdepth N -delete` silently misses files nested deeper than N** — cost real time
  during this build: a cleanup command used `-maxdepth 3` to clear `*.tsbuildinfo` files, but
  3-level-deep package paths (`packages/chains/ethereum/tsconfig.tsbuildinfo`) are actually 4
  path components deep, so their stale build-cache files survived a `dist/` wipe. The result was
  a `tsc -b` run that believed stale cache state over the actual (deleted) files on disk and
  threw `TS6305` ("output file has not been built from source"). Fix: when clearing build
  artifacts across a monorepo, don't bound `-maxdepth` at all (or go wide enough on purpose) —
  bound by name/pattern instead.
- **Don't trust an AI-summarized fetch of a page you're about to script against** — a first pass
  at finding the current OFAC SDN list download endpoint returned a plausible-looking but
  non-existent hostname (`ofacwebdev.wc2h.treasury.gov`), apparently misread from the page's own
  internal API references during summarization. Caught by actually `curl`-testing the URL before
  writing the ingestion script against it (it failed to connect at all), then finding the real,
  working, redirect-following URL (`https://www.treasury.gov/ofac/downloads/sdn.csv`) the same
  way. For anything a script will depend on working, verify by hitting it directly — a fetched
  summary is a lead, not a source of truth.
- **OFAC's flat-file SDN.CSV has no structured column for digital-currency addresses** — they're
  embedded as semi-structured text inside the free-text `Remarks` column, e.g.
  `Digital Currency Address - ETH 0xabc...; alt. Digital Currency Address - ETH 0xdef...;`.
  Confirmed by downloading and grepping the real file before writing the regex parser, not
  assumed from any documentation page (OFAC's own docs pages for this didn't actually show the
  format directly either).
