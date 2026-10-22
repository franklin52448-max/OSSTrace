# @osstrace/web

Minimal React + Vite + Tailwind UI for the Explorer and Visualizer APIs. Paste a chain + address,
see its balance, recent transactions, and any sourced label/tags — or switch to the **Graph** tab
to see its recent transactions as an interactive graph.

## Running it

Needs the Explorer API running first (`npm run dev:explorer` from the repo root, or
`npm run dev --workspace packages/features/explorer`). The Graph tab also needs the Visualizer API
(`npm run dev:visualizer`).

```sh
npm run dev --workspace packages/web
# or, from the repo root:
npm run dev:web
```

Opens on port 5301 (this project's port block is 5300–5399; the Explorer API itself is on 5300).
Talks to the Explorer API at `VITE_EXPLORER_URL` (defaults to `http://localhost:5300`) and the
Visualizer API at `VITE_VISUALIZER_URL` (defaults to `http://localhost:5302`). Logging in and
label submission/moderation also need the accounts API (`npm run dev:accounts`,
`VITE_ACCOUNTS_URL`, default `http://localhost:5310`) and the community labels API
(`npm run dev:community-labels`, `VITE_COMMUNITY_LABELS_URL`, default `http://localhost:5311`).
Lookups and the graph work without either of them.

## Tests

```sh
npm test            # from the repo root: every package's tests, these included
npm run check       # typecheck (including packages/web/tests) + tests
node --experimental-strip-types --test packages/web/tests/*.test.ts   # just this package
```

Plain functions (`src/layout.ts`, `src/txDisplay.ts`) are tested directly. Components are tested
by rendering the real ones into a real DOM and driving them the way a user does, against the
real backend APIs. The harness lives in `tests/harness/`:

- **`env.ts`**: puts a [jsdom](https://github.com/jsdom/jsdom) window on `globalThis` and
  registers a Node module hook that compiles `src/*.ts(x)` with Oxc (`rolldown`'s
  `transformSync`, the same transformer Vite 8 uses), so a test can `import("../src/App.tsx")`
  under plain `node --test`. It also builds `import.meta.env` from `process.env`'s `VITE_*`
  variables, which is what Vite does at build time. `fetch` and `WebSocket` stay Node's own, so
  every request the UI makes is real HTTP.
- **`render.ts`**: `render`/`cleanup` over `react-dom/client` + React's `act()`, and a handful of
  helpers: `type` (sets the value and fires a real `input` event), `click` (real clicks, so a
  submit button runs the browser's validation and submission steps), `getByLabelText` (finds a
  control through its `<label>` and `label.control`, the way assistive tech does), `waitFor` and
  `during` (let real I/O happen inside `act()`). Any `console.error` is collected so tests can
  assert React reported nothing.
- **`servers.ts`**: starts the real accounts, community-labels and Explorer handlers on ephemeral
  ports over temp-file stores, and points the UI's `VITE_*_URL`s at them. The upstream chain is
  a small fixed-balance `ChainAdapter`, as in the Explorer's own tests. The one thing a test
  controls is timing: every Explorer request is held at the server until the test releases it,
  so responses can be made to land in any order.

Why not `@testing-library/react` + Vitest/Jest: the rest of the repo is plain `node --test` with
real servers and no mocking framework, and these tests only need a few helpers. Adding a second
test runner and its config to get them wasn't worth it. Every helper here is a thin layer over a
real DOM API, so swapping in Testing Library later would be a small change if the suite grows.

What's covered so far:

- `tests/lookupRace.test.ts`: a slow lookup of A that lands after B's never replaces B's report.
  Neither does a label-submission refresh of A that lands after the user looked up B. A slow
  refresh that nothing has superseded still lands.
- `tests/accountPanel.test.ts`: the email/password inputs are named by visible `<label>`s in both
  modes. A failed log in or sign up (real API errors) lands in the form's single `role="alert"`
  region, which is mounted before the error appears.

Each test file runs in its own process (`node --test` does that), and the hook only applies there,
so the harness never affects the Vite dev server or build.

## What's here

The UI is built on a React port of [Helium Prism](https://github.com/imputnet/helium-prism) in
`src/prism/` (see its README). The layout is an intel-dashboard shell: a sticky top bar holds the
wordmark, the view links, a global chain + address search and the account menu.

The URL hash is the router (there's no router library). `#address/<chain>/<address>` is a Lookup
report, and every address in the UI links to its own report, so lookups are shareable.
`#graph/<chain>/<address>` opens the Visualizer already graphing that address. That's where a
report's **Visualize** button goes. The other views are `#trace`, `#cases`, `#bounties` and
`#moderation`.

- **Account** (`src/AccountPanel.tsx`, `src/session.ts`): the top-bar account menu, with an
  email + password log in / sign up popover backed by the real accounts API. The session token is kept in `localStorage`
  (`osstrace.session`) and sent as a bearer header. On load the page asks `/accounts/me` who the
  token belongs to, because a role is never trusted from storage. Log out revokes the session
  server-side.
- **Lookup**: a home page with the search, and an entity-style report for each address. The
  report has a header (sourced label or "Unlabeled address", chain, badges, copyable address,
  Visualize / Trace / block-explorer actions), stat cards (balance, transaction count, sourced
  tags) and a transactions table (time, tx, from, to, value). The side column holds the risk score,
  your private label and label suggestions. A "SANCTIONED" badge shows when the `sanctioned` tag is
  present. A community label
  gets a **✓ CONFIRMED** badge (sky blue) once a moderator confirms it, or a **COMMUNITY ·
  UNREVIEWED** badge before that (`src/LabelReview.tsx`). Ingested labels from official sources get
  neither. Logged-in users see **Suggest a label for this address**, a form that requires a source
  URL + description and posts to the community labels API. Every lookup and refresh is tagged, and
  a response for an address you've since moved off (a slow earlier lookup, or the refresh after a
  label submission) is dropped rather than replacing the report on screen.
- **Moderation** (`src/ModerationView.tsx`, tab shown only to moderators/admins): the queue of
  pending community submissions with their sources. **Confirm** or **Reject…** (with a reason). A
  moderator's own submissions can't be reviewed by them, and the server enforces both rules.
- **Graph** (`src/GraphView.tsx`): the Visualizer's one-hop graph drawn as SVG. Drag the
  background to pan, scroll (or the +/− buttons) to zoom, drag a node to move it, click a node to
  see its address, label + source, tags, totals and the transfers behind each edge (linked to
  Etherscan/Solscan). "Graph this address" re-centers on a counterparty with a fresh real query.
  Edges are green into the queried address and orange out of it; labeled nodes are amber,
  sanctioned ones red. Fetched transactions that can't be drawn (self-transfers, unresolved
  counterparties) are listed under the graph rather than hidden.
- **Risk score** (`src/RiskPanel.tsx`, a card on every Lookup result): press "Compute risk score"
  to call the risk scoring API (`npm run dev:risk`, `VITE_RISK_SCORING_URL`, default
  `http://localhost:5305`). On demand rather than automatic, because an untagged address costs a
  real multi-hop Tracer search. Shows the 0–100 score, the tier, the nearest flagged address with
  its real path, the cited sources, and a SEARCH INCOMPLETE chip plus every gap when the search
  didn't finish. An `inconclusive` result shows "—", never 0. See
  `packages/features/risk-scoring/README.md`.

The layout (`src/layout.ts`) is a small hand-rolled, deterministic force-directed layout — no
graph library dependency. A one-hop graph is a star of at most ~100 nodes, which doesn't need
one; `tests/layout.test.ts` covers it.

Each transaction row shows its native value, plus one line per decoded token transfer
(`tokenTransfers` from the API: ERC-20 on Ethereum, SPL on Solana). A token shows its symbol when
the data source reported one, otherwise its shortened contract/mint address — Solana mints never
have a symbol here, since the adapter doesn't fetch token metadata. If a token's decimals are
unknown, the exact raw integer amount is shown and labelled as raw units. A transaction the API
reports as `status: "failed"` (reverted on-chain) is marked **FAILED · nothing moved**, and its
amounts are struck through with no +/- sign or direction colour: they're what it attempted, not
what moved (`src/txDisplay.ts`, covered by `tests/txDisplay.test.ts`).

## Cases

**`src/CasesView.tsx`** (`#cases`): your own private cases, from the case-management API
(`npm run dev:cases`, port 5314, `VITE_CASES_URL`). It also needs the accounts API for logging in.
You can create a case, add Ethereum or Solana addresses with a note, edit or remove them, edit the
title and description, close it (read-only) or reopen it, and delete it after a confirm prompt.
Logged out, the tab shows a one-line hint. Fetched state is tagged with the session token it was
fetched for, and the detail view is keyed on token + case id. Switching accounts therefore never
shows the previous user's cases. This was verified by driving the real UI against the real APIs in
headless Chromium, watching every DOM mutation across an account switch. The automated component
suite (see **Tests**) doesn't cover this view yet. The API's isolation guarantees are tested in
`packages/features/case-management/tests/`.

## Accounts and private labels

These are optional, and both need APIs running: `npm run dev:accounts` (port 5310,
`VITE_ACCOUNTS_URL`) and `npm run dev:private-labels` (port 5312, `VITE_PRIVATE_LABELS_URL`).

- **`src/AccountBar.tsx`**: a log-in/sign-up form against the real accounts API. When you're signed
  in, it shows your email, a "My private labels" list and "Log out", which revokes the session
  server-side.
- **`src/PrivateLabelPanel.tsx`**: on every Lookup result, shows your own private label for that
  address and lets you add, edit or remove it. Logged out, it shows a one-line hint instead. Its
  styling is meant to be impossible to confuse with public labels: violet, a dashed border, a lock
  icon, "only visible to you", and no source, confidence or SANCTIONED-style badge.
- **`src/session.ts`**: the shared session. The bearer token is kept in `localStorage` so a reload
  keeps you signed in. Any `401` signs you out locally. Fetched label state is tagged with the
  session it was fetched for, so switching accounts in one browser never shows the previous
  user's label, not even for one frame.

## What's not built here yet

- The session token lives in `localStorage`, so any script on this origin could read it. That's
  fine for a local tool with no third-party scripts. Revisit it (an httpOnly cookie plus CSRF
  protection) before a public deployment.
- Private labels show on the Lookup view only, not on Graph nodes.

- The Graph tab is one hop at a time (see `packages/features/visualizer/README.md`); expanding a
  node in place is not built.
- Graph interaction is mouse/touch-pointer only — nodes aren't keyboard-focusable yet, though every
  transfer in the graph is also listed as text in the side panel.
- No loading skeletons/pagination — a known, disclosed cut for a one-day first build, not a
  design decision to defend.
- No build/deploy pipeline — `npm run build` produces a static `dist/`, but nothing wires that up
  to hosting yet.
- Account features are minimal: there's no "my submissions" page (the API has
  `GET /labels/submissions/mine`), no password reset, and no role management UI.
- Component tests cover only the Lookup view's response ordering and the login form's
  accessibility (see **Tests**). The submission, moderation, cases and graph views were verified by
  driving the real UI against the real APIs in headless Chromium during development, not by an
  automated suite. The API behaviour behind them is covered by each feature package's own tests.
