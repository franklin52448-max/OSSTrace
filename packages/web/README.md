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

## What's not built here yet

- The Graph tab is one hop at a time (see `packages/features/visualizer/README.md`); expanding a
  node in place is not built.
- Graph interaction is mouse/touch-pointer only — nodes aren't keyboard-focusable yet, though every
  transfer in the graph is also listed as text in the side panel.
- No loading skeletons/pagination — a known, disclosed cut for a one-day first build, not a
  design decision to defend.
- No build/deploy pipeline — `npm run build` produces a static `dist/`, but nothing wires that up
  to hosting yet.
