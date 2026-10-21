# Roadmap

Set tasks, phased by real dependency order, so nothing gets silently skipped. Check items off as
they land; every checked item should also flip the status table in `README.md` in the same PR —
that table is the single source of truth for what's actually built.

## How this is organized

Phases are ordered so nothing is built on a foundation that doesn't exist yet. **Accounts/auth is
the one hard dependency** — label moderation (Confirmed tier) and private labels both need it, so
it's pulled forward even though it's not itself a "feature" a user sees directly.

Within a phase, items with no dependency on each other are fanned out in parallel (separate
folders, separate agents, same plugin architecture that made this possible in the first place).

---

## Wave 1 — in progress

- [ ] **Harden what's already built**
  - [x] Fix the Explorer cache key not including `?limit=` (reports are now keyed per address +
        limit — see `packages/features/explorer/README.md`)
  - [x] Decode ERC-20 token transfers in the Ethereum adapter (Etherscan `tokentx`, merged into
        `tokenTransfers` — see `packages/chains/ethereum/README.md`; the keyed live Etherscan test
        skips until someone runs it with a real `ETHERSCAN_API_KEY`)
  - [x] Decode SPL token transfers in the Solana adapter (`transfer`/`transferChecked` into
        `tokenTransfers`, balance-delta fallback kept for the native side — see
        `packages/chains/solana/README.md`)
  - [ ] Document/streamline getting a real `ETHERSCAN_API_KEY` so Ethereum tx history actually
        works out of the box for a new contributor
- [x] **Accounts / auth system** (prerequisite for Wave 2's moderation + private labels)
  - [x] Design: provider choice, session model, how a "moderator" role is granted (ADR 0004 flags
        this as explicitly unresolved — resolved in
        [ADR 0006](docs/adr/0006-accounts-and-auth.md): self-hosted email + argon2id passwords,
        opaque hashed bearer sessions, first admin granted by the operator CLI only)
  - [x] Implement as its own plugin-shaped package, same pattern as everything else
        (`packages/features/accounts/`)
  - [x] Real tests, a README, and an ADR recording the design decision
  - [ ] Before any public deployment: login rate limiting, email verification + password reset
        (deferred in ADR 0006 — not needed by Wave 2, needed by real users)
- [ ] **More label sources** (ADR 0005 — grows the actual mission, doesn't block on anything)
  - [x] UK OFSI sanctions list ingestion script (same shape as `scripts/ingest-ofac-sdn.ts`) —
        `scripts/ingest-uk-sanctions.ts`; reads the UK Sanctions List, which replaced OFSI's
        Consolidated List as the single UK source on 28 Jan 2026
  - [ ] EU / UN / Canada SEMA sanctions lists, same pattern
  - [x] At least one GitHub-published open exchange/protocol address list, ingested and sourced —
        `scripts/ingest-safe-deployments.ts` (Safe's official `safe-global/safe-deployments`)
  - [ ] A GitHub-published *exchange* address list — none found yet whose data verifiably
        originates with the exchange itself rather than a scraped labeling platform (ADR 0005)
- [x] **Visualizer** (interactive transaction graph — builds directly on today's Explorer data
      layer, no new dependency)
  - [x] `packages/features/visualizer/` — paste an address, render its transaction graph
        (v1: one hop only; in-place multi-hop expansion is not built — see its README)
  - [x] Real tests, a README

## Wave 2 — after accounts lands

- [ ] **Label trust tiers** (ADR 0004): add `reviewStatus` to `Label`, build the Confirmed-tier
      moderation workflow, wire a "confirmed" badge into the web UI
- [x] **Private labels**: per-user, unshared, no source requirement (mirrors Arkham's own
      private-by-default model per ADR 0004) — `packages/features/private-labels/` (API +
      adversarial cross-user isolation tests) and a private-label panel + log-in/sign-up form in
      the web UI. "Share as a Community label" is not built.

## Wave 3 — next features

- [ ] **Risk Scoring** — address/entity risk indicators (sanctions exposure, hop-distance from a
      flagged address), builds on the label dataset + a new graph-traversal piece
- [ ] **Case Management** — group findings into a structured record; needs accounts (who owns a
      case) so naturally sequenced after Wave 1's accounts work

## Wave 4 — the hard one

- [ ] **Tracer** — hop-by-hop fund tracing, including across bridges between chains. Flagged in
      the PRD as the most complex remaining feature; do this once the team has real bandwidth for
      it, not squeezed in alongside something else.

## Wave 5 — breadth

- [ ] **More chains** beyond Ethereum/Solana (Bitcoin, Tron, etc.) — each is its own
      `ChainAdapter` implementation, independently addable at any point once a real data source is
      identified for that chain (see `packages/chains/README.md`)

## Wave 6 — going from "works locally" to "works for real users"

- [ ] Deployment story for the Explorer API, the background indexer (as a real long-running
      process, not a terminal script), and the web UI's static build
- [ ] Real-time streaming (websocket) layer
- [ ] Everything in `SCALING-AND-COSTS.md` (local only, not in this repo) once there's a real
      hosting target to plan against

---

## Ground rules for every item on this list

Same rules as everywhere else in this project, repeated here because a roadmap is exactly the
place someone might be tempted to cut a corner to check a box faster:

- No mock/fake/placeholder data or behavior, ever, even to get a demo working.
- Every label/tag needs a real cited source (ADR 0002) — no exceptions for roadmap speed.
- Never scrape Arkham or similar for data (ADR 0004/0005).
- A feature isn't done without a real README and real tests — see `FEATURE_GUIDELINES.md`.
- Update this file and the README status table in the same PR that changes a feature's status.
