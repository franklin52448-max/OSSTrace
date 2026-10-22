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

- [x] **Label trust tiers** (ADR 0004): add `reviewStatus` to `Label`, build the Confirmed-tier
      moderation workflow, wire a "confirmed" badge into the web UI — done in
      `packages/features/community-labels/` + the web UI's login, "Suggest a label" and Moderation
      tab; design in [ADR 0007](docs/adr/0007-community-label-submissions-and-review.md)
      (ingested labels carry no `reviewStatus`; moderators can't review their own submissions)
  - [ ] Before any public deployment: rate limiting on submissions (ADR 0007 "Deferred")
- [x] **Private labels**: per-user, unshared, no source requirement (mirrors Arkham's own
      private-by-default model per ADR 0004) — `packages/features/private-labels/` (API +
      adversarial cross-user isolation tests) and a private-label panel in the web UI, sharing the
      same login session as the Community/Confirmed tiers above. "Share as a Community label" is
      not built.

## Wave 3 — next features

- [x] **Risk Scoring** — `packages/features/risk-scoring/`,
      [ADR 0010](docs/adr/0010-risk-scoring-model.md): `GET /risk/:chain/:address` scores an address
      0–100 from a real risk tag on the address itself (100) or the nearest risk-tagged address
      within 1–3 hops, found with Tracer's own `traceGraph` (75/50/25). Returns the real tag, its
      source and the real path as evidence. An unfinished search (breadth/budget cap, unavailable
      node, or a full history page) is `inconclusive` with `searchIncomplete: true`, never `none`.
      A "Risk score" card on the web UI's Lookup report.
  - [ ] Only one risk tag exists in the real data today (`sanctioned`, OFAC + UK). More risk
        sources (sourced exploit/hacker lists, ADR 0005 §3) would each need their own row in ADR 0010.
  - [ ] Entity-level scores, cross-chain exposure, and a core "more history exists" signal on
        `TransactionsResult` (closes the Ethereum truncation edge in ADR 0010) — not built.
- [x] **Case Management** — group findings into a structured record (`packages/features/case-management/`,
      [ADR 0011](docs/adr/0011-case-management-private-owner-only-cases.md)): create/list/get/edit,
      close (read-only) / reopen, delete a case; add real addresses (validated + canonicalized via
      `@osstrace/core`) with your own note, edit the note, remove them. **Private to the owner
      only** — no sharing, and no moderator/admin read path (ADR 0011 §2–3); someone else's case
      is indistinguishable from a nonexistent one. Adversarial cross-user isolation tests at the
      service and full-HTTP level, and a real Cases tab in the web UI
      (`packages/web/src/CasesView.tsx`).
  - [ ] Sharing / collaborators — deliberately not in v1; needs its own ADR (ADR 0011 §2)
  - [ ] "Add to case" from the Lookup / Graph / Trace views (today an address is pasted on the
        Cases tab)
  - [ ] Delete a user's cases when account deletion exists (ADR 0006 defers account deletion)

## Wave 4 — the hard one

- [x] **Tracer** — multi-hop fund tracing, Ethereum + Solana (`packages/features/tracer/`,
      [ADR 0008](docs/adr/0008-tracer-multi-hop-search-design.md)): a real multi-hop graph
      expansion (`traceGraph`) and a point-to-point "does a path exist from A to B matching these
      filters" query (`tracePath`), both built directly on Visualizer's one-hop edge resolution.
      Up to 3 hops, breadth/call-budget capped, honest about depth-cap vs breadth-cap vs
      budget-exhausted vs unavailable.
  - [ ] **Bridges / cross-chain tracing — not built.** Both entry points take one chain and never
        cross it; this was the part of the PRD's "most complex remaining feature" framing that's
        still genuinely unsolved, not a cut corner hidden here.

## Wave 5 — breadth

- [ ] **More chains** beyond Ethereum/Solana (Bitcoin, Tron, etc.) — each is its own
      `ChainAdapter` implementation, independently addable at any point once a real data source is
      identified for that chain (see `packages/chains/README.md`)

## Wave 6 — going from "works locally" to "works for real users"

- [ ] Deployment story for the Explorer API, the background indexer (as a real long-running
      process, not a terminal script), and the web UI's static build
- [x] Real-time streaming (websocket) layer — `ws://<explorer>/stream`
      ([ADR 0013](docs/adr/0013-real-time-streaming-rides-the-indexer.md),
      `packages/features/explorer/README.md`): pushes ride on the background indexer's existing
      refetches (a tx-hash diff between consecutive fetches), so zero new RPC calls. Web UI Lookup
      view shows a live badge and pushed transactions.
  - [ ] Only the indexer's top-N addresses get pushes; a bounded per-subscriber watch list would
        need its own cost design (ADR 0013 §3 explains why it wasn't done by default)
  - [ ] Before any public deployment: `Origin` check and per-IP connection limits on the stream
- [ ] Everything in `SCALING-AND-COSTS.md` (local only, not in this repo) once there's a real
      hosting target to plan against

## Wave 7 — Bounty program

**The idea:** a feature request shouldn't require the person who wants it to be able to build it.
Any user — technical or not — opens a bounty: a written-up feature spec (what it does, how it
should behave, what "done" looks like) and their own stated reward. A public board lists open
bounties. Anyone submits a PR against one; a moderator records which submission wins.

- [x] **The board itself: live** (`packages/features/bounties/`,
      [ADR 0009](docs/adr/0009-bounty-program-v1-is-tracking-only.md)) — open/list/get a bounty,
      submit a PR against one, a moderator claims the winner, the opener or a moderator cancels.
      A real web UI tab (`packages/web/src/BountiesView.tsx`). Real tests throughout.
  - [x] **The funding/custody question is resolved for v1 by scoping it out, not deferred
        forever.** ADR 0009: this system never holds or moves a reward — `reward` is the poster's
        own free-text claim, and payout happens off-platform after a moderator records the claim.
        This directly avoids the custody conflict with `PRD.md`'s non-goal, rather than resolving
        it the way that non-goal would otherwise require (a real token + escrow design).
  - [ ] **A real token + escrow system, if this project ever builds one, is new scope** needing
        its own ADR — not an extension of ADR 0009. Still fully undecided: whether this ever
        happens, what token, and how a payout would be verified on-chain.
  - [ ] No rate limiting on opening bounties or submitting PRs; no automatic PR-status checking;
        no structured dispute process beyond a moderator's judgment call on which submission wins.
- [x] **First bounty posted:** an AI agent that answers real on-chain questions in plain language
      by actually calling this project's own tools — not by guessing. Example: *"is wallet A
      connected to wallet B?"* / *"did wallet A send wallet B more than $100 in USDC within the
      last 30 days?"* The agent uses **Tracer**'s `tracePath` (Wave 4, built —
      `packages/features/tracer/`) to check the real transaction graph and answer with a real,
      checkable result, honestly surfacing `budgetExhausted` rather than flattening "didn't finish
      searching" into the same "no" as "proven not connected" (ADR 0008 §4). The agent itself is
      not built — this is the spec posted to the board, waiting for a submission.

---

## Ground rules for every item on this list

Same rules as everywhere else in this project, repeated here because a roadmap is exactly the
place someone might be tempted to cut a corner to check a box faster:

- No mock/fake/placeholder data or behavior, ever, even to get a demo working.
- Every label/tag needs a real cited source (ADR 0002) — no exceptions for roadmap speed.
- Never scrape Arkham or similar for data (ADR 0004/0005).
- A feature isn't done without a real README and real tests — see `FEATURE_GUIDELINES.md`.
- Update this file and the README status table in the same PR that changes a feature's status.
