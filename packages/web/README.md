# @opentrace/web

Minimal React + Vite + Tailwind UI for the Explorer API. Paste a chain + address, see its
balance, recent transactions, and any sourced label/tags.

## Running it

Needs the Explorer API running first (`npm run dev:explorer` from the repo root, or
`npm run dev --workspace packages/features/explorer`).

```sh
npm run dev --workspace packages/web
# or, from the repo root:
npm run dev:web
```

Opens on port 5301 (this project's port block is 5300–5399; the Explorer API itself is on 5300).
Talks to the Explorer API at `VITE_EXPLORER_URL` (defaults to `http://localhost:5300`).

## What's here

One page (`src/App.tsx`): a chain selector, an address input, and a results panel (balance,
transactions, label/tags, with a "SANCTIONED" badge when the `sanctioned` tag is present). No
routing, no state management library — there's one screen, it doesn't need either yet.

## What's not built here yet

- No Visualizer (graph view) — this UI only covers the Explorer feature.
- No loading skeletons/pagination — a known, disclosed cut for a one-day first build, not a
  design decision to defend.
- No build/deploy pipeline — `npm run build` produces a static `dist/`, but nothing wires that up
  to hosting yet.
