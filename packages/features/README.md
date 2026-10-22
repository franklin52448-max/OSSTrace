# Features

Each subfolder is a self-contained feature, consuming `@osstrace/core` and the chain registry.
A feature never reaches into another feature's internals — if Visualizer needs something Explorer
computes, that logic belongs in `@osstrace/core` (or its own shared package), not borrowed
directly from Explorer's source.

## Currently implemented

- [`explorer/`](explorer/README.md) — given a chain + address, returns balance, recent
  transactions, and any label/tags/entity on record. Everything else (Visualizer, Tracer, Risk
  Scoring, Case Management) is meant to build on this same data layer.
- [`accounts/`](accounts/README.md) — real user accounts: signup/login, server-side sessions,
  `user`/`moderator`/`admin` roles. A foundation package: other features (Confirmed-tier
  moderation, private labels, Case Management) depend on its public API (`@osstrace/accounts`)
  to answer "who is this?" and "may they do this?", rather than each building their own auth.
- [`private-labels/`](private-labels/README.md) — a signed-in user's own free-text labels on
  addresses (ADR 0004). They're visible only to that user, need no source, and are never merged
  into the public label dataset. Built on `@osstrace/accounts`' `authenticate()`.
- [`community-labels/`](community-labels/README.md) — logged-in users submit labels with a
  required cited source; moderators confirm or reject them (ADR 0004 tiers 1–2, ADR 0007).
  Lookups read the results through a read-only `CommunityLabelReader`, after every ingested
  dataset.
- [`visualizer/`](visualizer/README.md) — given a chain + address, returns a one-hop transaction
  graph (center node, one node per direct counterparty, one edge per real transfer, labels/tags on
  every node). Drawn interactively by the web UI's Graph tab.
- [`tracer/`](tracer/README.md) — follows fund flow further than one hop: a real multi-hop graph
  expansion, and a point-to-point "does a path exist from A to B matching these filters" query
  (ADR 0008). Builds directly on Visualizer's one-hop edge resolution rather than reimplementing it.
- [`risk-scoring/`](risk-scoring/README.md) — scores an address 0–100 from a real risk tag on the
  address itself or the nearest risk-tagged address within 1–3 hops (ADR 0010), reusing Tracer's
  `traceGraph` directly. An unfinished search is reported `inconclusive`, never as a clean `none`.
- [`bounties/`](bounties/README.md) — a public board where anyone funds a feature spec with a
  self-stated reward, anyone submits a PR against it, and a moderator records the winner (ADR
  0009). Tracks the workflow; never holds or moves the reward itself. Built on
  `@osstrace/accounts`, same pattern as private/community labels.
- [`case-management/`](case-management/README.md) — a signed-in user groups real addresses, each
  with their own note, into an owned open/closed case (ADR 0011). Private to its owner only — no
  sharing, and no moderator/admin read path. Built on `@osstrace/accounts`' `authenticate()` and
  `@osstrace/core`'s address checks.

## Adding a feature

Read [`../../FEATURE_GUIDELINES.md`](../../FEATURE_GUIDELINES.md) first — the hard rules and house
style. Then:

1. `mkdir packages/features/<feature-name>` with the same shape as `explorer/`.
2. Consume `@osstrace/core` (types, `LabelStore`) and the chain registry pattern from
   `explorer/src/registry.ts` — don't reinvent chain wiring per feature.
3. Write a `README.md`: what the feature does, what it exposes (an API? a UI? both?), and what's
   not built yet.
4. Add it to the root `package.json` workspaces glob (`packages/features/*` already covers new
   folders automatically) and wire a `dev:<feature>` script if it runs its own server.
