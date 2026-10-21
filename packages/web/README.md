# @opentrace/web

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
Visualizer API at `VITE_VISUALIZER_URL` (defaults to `http://localhost:5302`).

## What's here

One page (`src/App.tsx`) with two tabs, switched by the URL hash (`#graph`) — no router library:

- **Lookup**: a chain selector, an address input, and a results panel (balance, transactions,
  label/tags, with a "SANCTIONED" badge when the `sanctioned` tag is present).
- **Graph** (`src/GraphView.tsx`): the Visualizer's one-hop graph drawn as SVG. Drag the
  background to pan, scroll (or the +/− buttons) to zoom, drag a node to move it, click a node to
  see its address, label + source, tags, totals and the transfers behind each edge (linked to
  Etherscan/Solscan). "Graph this address" re-centers on a counterparty with a fresh real query.
  Edges are green into the queried address and orange out of it; labeled nodes are amber,
  sanctioned ones red. Fetched transactions that can't be drawn (self-transfers, unresolved
  counterparties) are listed under the graph rather than hidden.

The layout (`src/layout.ts`) is a small hand-rolled, deterministic force-directed layout — no
graph library dependency. A one-hop graph is a star of at most ~100 nodes, which doesn't need
one; `tests/layout.test.ts` covers it.

Each transaction row shows its native value, plus one line per decoded token transfer
(`tokenTransfers` from the API: ERC-20 on Ethereum, SPL on Solana). A token shows its symbol when
the data source reported one, otherwise its shortened contract/mint address — Solana mints never
have a symbol here, since the adapter doesn't fetch token metadata. If a token's decimals are
unknown, the exact raw integer amount is shown and labelled as raw units.

## Accounts and private labels

These are optional, and both need APIs running: `npm run dev:accounts` (port 5310,
`VITE_ACCOUNTS_URL`) and `npm run dev:private-labels` (port 5311, `VITE_PRIVATE_LABELS_URL`).

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
