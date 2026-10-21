# Features

Each subfolder is a self-contained feature, consuming `@opentrace/core` and the chain registry.
A feature never reaches into another feature's internals — if Visualizer needs something Explorer
computes, that logic belongs in `@opentrace/core` (or its own shared package), not borrowed
directly from Explorer's source.

## Currently implemented

- [`explorer/`](explorer/README.md) — given a chain + address, returns balance, recent
  transactions, and any label/tags/entity on record. Everything else (Visualizer, Tracer, Risk
  Scoring, Case Management) is meant to build on this same data layer.

## Adding a feature

Read [`../../FEATURE_GUIDELINES.md`](../../FEATURE_GUIDELINES.md) first — the hard rules and house
style. Then:

1. `mkdir packages/features/<feature-name>` with the same shape as `explorer/`.
2. Consume `@opentrace/core` (types, `LabelStore`) and the chain registry pattern from
   `explorer/src/registry.ts` — don't reinvent chain wiring per feature.
3. Write a `README.md`: what the feature does, what it exposes (an API? a UI? both?), and what's
   not built yet.
4. Add it to the root `package.json` workspaces glob (`packages/features/*` already covers new
   folders automatically) and wire a `dev:<feature>` script if it runs its own server.
