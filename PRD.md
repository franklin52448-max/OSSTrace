# Product Requirements Document: OpenTraceIntelligence

**Status:** Early development, local-only, not yet pushed to GitHub
**Last updated:** 2026-10-21
**Document owner:** the operator

---

## 1. Problem Statement / Why This Exists

On-chain intelligence — looking up a wallet address, seeing its transaction history, and knowing whether it belongs to a known entity (an exchange, a sanctioned actor, a hacker) — is one of the most load-bearing tools in crypto investigation, compliance, and research. Today that space is dominated by closed, proprietary platforms. The immediate trigger for this project: Arkham (arkm.com) just launched a paid "Arkham Enterprise" tier and moved previously-free capability behind it.

OpenTraceIntelligence is an independent, from-scratch alternative to the same underlying *idea* — not a copy of Arkham's name, branding, product, or data. It does not reuse, scrape, or derive from any proprietary labelset. It exists to prove that the same category of tool (address lookup, entity labeling, visualization, tracing, risk scoring) can be built and kept genuinely open: free to run, free to audit, free to extend, with every data point checkable against a real public source.

The problem this solves has two layers:

1. **For users of the tool:** on-chain transparency tooling shouldn't require paying a company for data that is, in large part, derivable from already-public sources (sanctions lists, public incident reports, public address disclosures).
2. **For the ecosystem:** there is currently no large, openly-licensed, source-cited labeled-address database that anyone can build on without a commercial relationship. That absence is itself the gap this project is trying to fill — permanently, not as a stepping stone to its own paywall.

## 2. Goals

1. **Build and keep public, forever, the largest openly-licensed labeled wallet/entity database that exists.** This is a first-class goal of the project, not a side effect of building features (see ADR 0005). Every entry must be real and sourced; "largest" is a long-horizon target, not a near-term deliverable.
2. **Ship a real, working multi-chain address-lookup tool.** Balance, transaction history, and any known label/tag for an address, starting with Ethereum and Solana, expanding to more chains over time.
3. **Make the codebase trivially extensible by outside contributors — human or AI agent — without requiring them to read the whole codebase first.** This is stated in the project's own README as the *primary* design goal, on equal footing with the data mission, not a secondary engineering nicety. Every architectural choice (plugin-shaped chains, plugin-shaped features, a README in every folder, ADRs instead of tribal knowledge) exists to serve this.
4. **Grow label coverage only from legitimate public sources**, compounding over time: more government sanctions lists, open/public exchange and protocol address disclosures, public security-firm incident reports, and eventually a moderated community-contribution pipeline.
5. **Stay open permanently.** AGPL-3.0 licensing is itself a goal-supporting decision: it exists specifically to prevent a closed, hosted fork from becoming the de facto version of this tool while contributing nothing back.

## 3. Non-Goals / Explicit Scope Boundaries

- **Never scrapes or derives data from Arkham, or any similar proprietary platform.** This is a hard rule (ADR 0004), for three independent reasons: real legal/ToS risk, it would break the sourcing guarantee that is the project's entire value proposition, and it's a strategically worse approach than a compounding cited-source pipeline even ignoring the legal risk.
- **Read-only / observational, never custodial or transactional.** The project watches chains; it never signs or sends a transaction. A feature that requires wallet-signing or moving funds is explicitly out of scope — it's "a different kind of tool" (FEATURE_GUIDELINES.md).
- **No mock, fake, or placeholder data presented as real, ever — not even temporarily.** If a capability isn't built, it is disclosed as not-built in the relevant README, never faked behind a working-looking UI.
- **Not a replica of Arkham's name, branding, or UI.** Independent build of the same category of tool. Visual identity/branding is explicitly undecided and out of scope for this document (the operator is handling that separately).
- **Self-attested wallet ownership and private per-user labels are designed but deliberately not being built yet** — they require real signature-proof security work and a real accounts system, each treated as its own future scope, not squeezed in now.
- **No accounts/auth system exists yet**, and nothing requiring it (moderation, private labels, self-attestation) is in scope until that prerequisite is built.

## 4. Target Users

- **On-chain investigators and researchers** (journalists, compliance analysts, open-source-intelligence researchers) who want address-lookup and labeling without a paid enterprise tier or vendor lock-in.
- **Outside contributors — human developers and AI coding agents** who want to extend the platform (a new chain, a new feature, a new label source) via a well-documented plugin boundary, without needing deep context on the rest of the system. This group is a named, deliberate target audience, not just a hoped-for side benefit — the architecture is built to make contribution from this group low-friction.
- **Other projects, researchers, and institutions** who want to consume or build on an openly-licensed labeled-address dataset directly, independent of using this project's own UI/API.

## 5. Architecture Summary

OpenTraceIntelligence is a **plugin-shaped monorepo**, organized so that every new capability — a chain or a feature — is an isolated, self-contained addition rather than a change to a shared "god" file.

- **`packages/core`** is the only place the shared data model and contracts live: the `Address` / `Entity` / `Label` / `Tag` / `Source` types, the `ChainAdapter` interface every chain must implement, and the `LabelStore`/`Cache` interfaces. Core itself contains zero chain-specific or feature-specific logic — it only defines the shapes other packages agree to.
- **`packages/chains/<chain>`** — one folder per supported blockchain, each implementing the single `ChainAdapter` interface (`getBalance`, `getRecentTransactions`). Adding a new chain never requires touching core or any existing chain's code, beyond one line registering a new `ChainId` and one registry entry in the Explorer feature. This boundary is deliberate: the ADR record notes that even Arkham's own supported-chain list has visibly churned over time, which is read as evidence that chain support is inherently a plugin surface, not something to hardcode.
- **`packages/features/<feature>`** — one folder per product feature (Explorer today), each consuming `core` and the chain registry, never reaching directly into another feature's internals. Anything one feature needs that another already computes belongs in `core` (or a new shared package), not borrowed informally.
- **`packages/web`** — a minimal React UI consuming the Explorer API over plain HTTP; it has no knowledge of chain adapters or the label store directly.
- **`data/labels`** — the actual sourced label/tag dataset, plus the ingestion scripts (e.g. `scripts/ingest-ofac-sdn.ts`) that produce it from real public sources.
- **`docs/adr`** — durable architectural decisions recorded as ADRs instead of living only in chat history or someone's memory, so a new contributor can learn *why* a structural choice was made without having been present for it.

The unifying design discipline: **every package carries its own `README.md`** stating what it is, how it plugs into the rest, and how to extend it — explicitly so no contributor (human or agent) has to read a single mega-README, or the rest of the codebase, before making a focused, safe change.

## 6. Feature Inventory (Status as of 2026-10-21, from README.md)

| Feature | Status |
|---|:---:|
| Core data model (Address / Entity / Label / Tag / Source) | **Active** |
| `ChainAdapter` plugin interface | **Active** |
| Ethereum chain adapter (balance via public RPC; tx history needs a free Etherscan API key) | **Active** |
| Solana chain adapter (balance + tx history via public RPC, no key needed) | **Active** |
| Explorer API (`GET /address/:chain/:address` — balance, recent txs, label, tags) | **Active** |
| Caching + a background indexer (real Redis-backed, keeps popular addresses instant) | **Active** |
| Minimal web UI (paste an address, see what we know) | **Active** |
| Seed labelset: OFAC SDN sanctioned digital-currency addresses | **Active** |
| Visualizer (interactive transaction graph) | **Not built** |
| Tracer (hop-by-hop fund tracing across chains/bridges) | **Not built** |
| Risk scoring | **Not built** |
| Case management | **Not built** |
| Real-time streaming (websocket) | **Not built** |
| More chains (Bitcoin, Tron, etc.) | **Not built** |

**What's verified working today, specifically** (not just "coded," but exercised against real systems):

- Ethereum and Solana adapters tested live against real mainnet RPC endpoints, returning real balances and real transaction history (not mocked responses at any point).
- The Solana adapter was fixed from an N+1 RPC-call-per-transaction pattern to a single batched `getParsedTransactions` call — a real, measured fix for the most significant cost/latency problem identified in the project so far.
- Redis-backed caching and a separate background indexer process were verified as two independent OS processes sharing one real Redis instance, with measured latency: ~160ms cold vs. ~15–20ms cached.
- The Explorer API and a minimal web UI are both running end-to-end against this stack.
- A seed labelset of 89 addresses across Ethereum and Solana was ingested from the real, live U.S. Treasury OFAC SDN sanctions list (stablecoin addresses in that list are deliberately skipped, since OFAC doesn't record which chain they're actually on, and guessing would risk mislabeling).

Also not yet built: accounts/authentication, the label moderation workflow (see §7), and additional chains beyond Ethereum and Solana.

## 7. Data Model Summary

Defined once in `packages/core/src/types.ts`, reused by every chain adapter and feature — deliberately shaped to mirror the proven model that existing on-chain intelligence tools converge on (researched from Arkham's own public API documentation as a structural reference, with none of their actual data reused):

- **`Address`** — `{ chain, value }`, always scoped to one specific chain, value kept in its chain-native format (never normalized).
- **`Entity`** — a real-world actor that can hold addresses across multiple chains.
- **`Label`** — at most one per address; a human-readable identity (e.g. `"Binance 14"`), carrying a `confidence` (`"verified" | "predicted"`) and a required `Source`.
- **`Tag`** — independent of labeling; a behavior/category marker (e.g. `"sanctioned"`, `"exchange"`, `"mixer"`); an address can be tagged without being labeled. Also requires a `Source`.
- **`Source`** — `{ description, url, addedAt }`, required on every `Label` and `Tag`. This is enforced structurally: there is no constructor, store method, or ingestion script in the codebase capable of producing a `Label` or `Tag` without one.
- **`Balance`** / **`TransactionSummary`** / **`TransactionsResult`** — chain-returned data, with a deliberate `{ available: true, transactions } | { available: false, reason }` shape so a caller can distinguish "we checked, there's nothing" from "we couldn't check" (no silent empty arrays standing in for a failure).

Storage today is a deliberately simple file-backed JSON store (`JsonFileLabelStore`) — a conscious v1 choice given a small, read-mostly seed dataset; swapping it for a real database later is treated as a same-interface change, not an architectural one.

## 8. Label Trust Model

**Status: designed and decided (ADR 0004). Private labels implemented; the Community/Confirmed tiers not yet.**

Three tiers are planned, two of which are intended to ship first:

1. **Community (default)** — anyone can submit a label for an address, still subject to the hard sourcing rule (a real URL or named document). Shown as-is, unreviewed.
2. **Confirmed** — a project moderator/admin reviews a Community label and marks it confirmed, with a distinct visual badge. This is a moderation action, tracked as its own field (`reviewStatus`), explicitly separate from the existing `confidence: "verified" | "predicted"` field, which describes something different (how the data was originally sourced, not whether a human later reviewed it).
3. **Self-attested (deliberately deferred)** — a wallet owner cryptographically proves control of an address via a signed message and labels it themselves. Not being built yet on purpose: it needs focused security design to avoid opening a spoofing/impersonation hole, rather than being bolted on alongside everything else.

**Private labels** (implemented in `packages/features/private-labels/`, with a panel in the web UI): any signed-in user can label an address for themselves only, never shown to anyone else, with no source requirement since it's not a public claim. This explicitly mirrors Arkham's own private-by-default custom-label model, identified as reasonable prior art worth reusing rather than reinventing differently for no reason. A later "share" action could promote a private label into a public Community submission, which would then need a real source to pass review.

**Shared prerequisite:** both Confirmed-tier moderation and private labels require a real accounts/auth system. That now exists (`packages/features/accounts/`, ADR 0006): self-hosted email + argon2id passwords, opaque server-side sessions, and `user` < `moderator` < `admin` roles. How moderation is granted is resolved there: the operator promotes the first admin from the command line (never over HTTP), and admins then grant `moderator` to others. Private labels are now built on it; the Community/Confirmed tiers are not yet.

## 9. Success Criteria

Drawn from what the project's own founding documents treat as the measures that matter:

- **Sourcing integrity holds at 100%, with no exceptions.** Every `Label` and `Tag` in the dataset — regardless of scale — carries a real, checkable `source`. This is treated as enforced by the type system, not a best-effort convention, and any erosion of it is treated as undermining the project's entire value proposition.
- **The labeled dataset grows over time from legitimate sources only**, and growth is never achieved by scraping Arkham or a similar platform, even under pressure to catch up on coverage.
- **A new contributor (human or AI agent) can add a chain or a feature by reading only the relevant folder's README and the top-level architecture docs** — not the whole codebase — and without breaking an unrelated chain or feature in the process.
- **The README status table stays accurate as a forcing function**: a feature's status changes in the same PR that changes the feature, not as a follow-up someone forgets.
- **The project remains public and open under AGPL-3.0** — specifically, no hosted fork of it should be able to go closed-source without triggering the AGPL's network-use disclosure obligation.
- **No feature ships backed by mock, fake, or placeholder data presented as real**, at any point, even temporarily.

No numeric targets (addresses labeled, chains supported, users served, uptime, latency SLAs) are defined anywhere in the project's current documentation. Where a number does exist (e.g. the ~160ms cold / ~15–20ms cached lookup latency), it is a measured result from real testing, not a committed target.

## 10. Open Questions / What's Undecided

- **GitHub home.** The project is currently 100% local; nothing has been pushed. The operator is setting up a dedicated GitHub account for this project (separate from other accounts) and will provide it later. Until then, there is no public repository, no public contribution pipeline, and no way for outside contributors to actually participate yet.
- **Branding/visual identity.** Explicitly not decided in these documents. The operator is getting help from a friend on this separately. No logo, tagline, or visual identity should be invented or assumed by anyone working on this project in the meantime — the name "OpenTraceIntelligence" is the only settled identity element.
- **Moderation governance.** *How* moderator authority is granted is decided (ADR 0006: operator CLI creates the first admin; admins grant moderators). *Who* should be a moderator — written criteria, removal, conflicts of interest — is still open, and deferred until there's a contributor community to write that policy with.
- **Accounts/auth hardening before public use.** The accounts system exists (ADR 0006), but email verification, password reset, login rate limiting and OAuth sign-in are deliberately deferred; the first two need outbound email, the third depends on the (undecided) deployment setup.
- **Self-attestation (signature-proof wallet ownership).** Deliberately deferred as its own future security-design effort; no design work has started beyond naming it as tier 3 of the trust model.
- **Which future label sources are ingested next, and in what order.** ADR 0005 names categories (more sanctions lists — UK OFSI, EU, UN, Canada's SEMA; GitHub-published open exchange/protocol address lists; public security-firm incident reports from firms like CertiK/SlowMist/PeckShield) but does not commit to a specific next source or sequence.
- **How to judge a borderline label source.** ADR 0005 flags that a future judgment call will be needed on whether some GitHub-published address list is itself an indirect copy of Arkham-originated data (out of bounds) versus genuinely independent and public (in bounds) — the test is stated (where the data originates, not where the file was found) but no process for applying it yet exists.
- **Deployment story.** No hosting/deployment plan exists for either the Explorer API, the background indexer as a long-running process, or the web UI's static build — all currently run as local dev-mode processes/scripts only.
- **Scope and timing of the next chain or feature.** Beyond the ADR's stated intent to eventually build Visualizer, Tracer, Risk Scoring, and Case Management (in that rough order of mention) and to add more chains beyond Ethereum/Solana, no prioritization, timeline, or design work for any of these has been committed to a document yet.
