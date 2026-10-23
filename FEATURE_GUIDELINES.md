# Adding a feature: rules and suggestions

This project's primary design goal is that someone outside the core team — a human contributor or
an AI coding agent — can add a feature without reading the whole codebase first. These rules exist
to keep that true as the project grows, not to slow anyone down for its own sake.

## Hard rules (a PR that breaks these gets rejected, no exceptions)

1. **Every `Label`/`Tag` needs a real, cited source.** No placeholder, guessed, or "I'll add the
   source later" entries. See [ADR 0002](docs/adr/0002-labels-require-a-cited-source.md).
2. **Never scrape Arkham, or any similar proprietary platform, for data.** See
   [ADR 0004](docs/adr/0004-label-trust-tiers-and-private-labels.md) for why. Public sanctions
   lists, public post-incident reports, public protocol disclosures, and this project's own
   community-contribution pipeline are the legitimate ways to grow coverage.
3. **This project never custodies or moves funds itself, and never sends a transaction on a
   user's behalf.** Narrowed 2026-10-23 from "never signs or sends a transaction" — that was
   written before wallet sign-in (Phantom/MetaMask) became the auth system: a user signing a
   *message* to prove address ownership (no transaction, no funds, nothing sent) is now core to
   the whole product and does belong here. The rule that's still absolute: the project itself never
   holds, moves, or has custody of anyone's funds — bounty "deposits" are a user sending their own
   funds, from their own wallet, to a public address, which this project only watches and verifies
   on-chain, never touches directly (see ADR 0020).
4. **No mock/fake/placeholder data presented as real**, ever — not even temporarily "to get the
   UI working." If something isn't built yet, say so in the feature's own README. A cosmetic
   stand-in that looks real is worse than an honest "not built yet."
5. **A feature isn't done without a README** in its own folder: what it is, how it plugs into
   `@osstrace/core` and the chain registry, and what it explicitly doesn't do yet.
6. **Update the root README's status table** in the same PR that adds or changes a feature's
   state. "Done" vs "not built" stays accurate by being part of the change, not a follow-up task
   someone forgets.

## Strong suggestions (deviate with a reason, ideally written down)

- **Keep API responses boring and consistent.** Reuse the `{available: true, ...} | {available:
  false, reason: string}` pattern for "this couldn't be fetched" rather than inventing a new shape
  per feature — error handling an agent (or a human) already learned once should keep working
  everywhere else.
- **Build for agent-readability, not just human-readability.** Predictable field names, no
  surprise nulls where an explicit status is clearer, and a README that states the contract
  plainly enough that an agent reading only that file could use the feature correctly.
- **Don't reach into another feature's internals.** If Visualizer needs something Explorer already
  computes, that logic belongs in `@osstrace/core` (or a new shared package), not borrowed
  directly from `packages/features/explorer/src/`.
- **Be a good citizen on shared external resources.** If a feature fans out multiple calls per
  request to a public RPC or a rate-limited API, say so in its README (expected call volume per
  use), and prefer caching/batching over brute-force per-request fan-out. See
  `SCALING-AND-COSTS.md` (local only, not in this repo) for why this matters at real scale.
- **No logging of what users search for.** A transparency tool that quietly tracks its own
  investigators' query history undermines the reason this project exists. If a feature needs
  usage metrics, aggregate and anonymize at the point of collection, not after the fact.
- **Real tests over mocks where it's feasible.** A chain adapter's test should hit a real public
  RPC (skip cleanly if unreachable) rather than mock the network layer — see the existing chain
  packages for the pattern.
- **Document expected cost/latency for anything that fans out.** A feature that makes N RPC calls
  per request should say so — this is exactly the kind of thing that quietly turns into a
  production incident or a huge bill once there's real traffic.

## Before you start

Read [`ARCHITECTURE.md`](ARCHITECTURE.md), then the `README.md` in whichever folder you're about
to touch (`packages/chains/README.md` for a new chain, `packages/features/README.md` for a new
feature). If what you want to build doesn't fit either plugin shape, open a discussion or propose
an ADR before building — don't bend the architecture around a one-off silently.
