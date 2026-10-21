# ADR 0004 — Label trust tiers, private labels, and where we won't source data from

Status: Decided 2026-10-21 (design locked). Private labels implemented in
`packages/features/private-labels/`; the Community/Confirmed tiers not yet.

## Context

ADR 0002 established that every label requires a cited source, enforced by the type system. That
covers *programmatic* ingestion (like the OFAC script). It doesn't yet cover the case this
project exists to make possible: regular people and outside investigators adding their own
labels, with some way to tell a random unverified claim apart from one the project's own
moderators have checked.

Separately, Arkham's own documented data model (confirmed via their public API docs during
research — see ADR 0001) already does something directly relevant here: custom labels/entities
are private to the user by default, with an explicit "Share" action to make one public. That's
good prior art, not something to reinvent differently for no reason.

## Decision

**Three label tiers** (two to start):

1. **Community** (default) — anyone can submit a label for an address, with a required source
   per ADR 0002 (a URL or named document). Shown as-is, unreviewed.
2. **Confirmed** — a project moderator/admin reviews a Community label and marks it confirmed.
   Gets a distinct visual mark (a "confirmed" badge, separate from the `confidence:
   "verified"|"predicted"` field that already exists — confirmation is a moderation action, not
   an ingestion-source property, so it's a new field, not a reuse of `confidence`).
3. **Self-attested (deferred)** — a wallet owner cryptographically proves control of their own
   address (a signed message) and labels it themselves. **Not building this yet.** It needs real
   security design (proving ownership without opening a spoofing/impersonation hole) that
   deserves its own focused pass, not a bolt-on. Revisit as a dedicated piece of work later.

**Private labels**: any user can label an address for themselves only — never shown to anyone
else, no source requirement (it's not a public claim, so ADR 0002's sourcing rule doesn't apply
to it). Mirrors Arkham's own private-by-default model. A later "share" action could promote a
private label into a Community submission, which *would* then need a real source to pass review.

**Both of these require real user accounts** (to know whose private label is whose, and who's
authorized to mark something Confirmed) — not built yet either. This ADR records the data-model
shape; the auth/accounts system is a separate, prerequisite piece of work.

## Where we will NOT source label data from

**Not scraping Arkham (or any similar proprietary platform) for labels, ever.** Three reasons,
all independently sufficient:
1. Their labelset is almost certainly their protected commercial asset (ToS violation, real legal
   risk — likely database-right infringement, not just "rude").
2. It defeats the entire premise of this project. One scraped, uncited entry breaks the "every
   label has a real, checkable source" guarantee for the whole dataset — the guarantee *is* the
   product.
3. It's a worse strategy even ignoring the above two — a scraped copy is a snapshot that rots,
   while a cited, structurally-enforced sourcing pipeline (ADR 0002) compounds over time as more
   real sources and contributors get added.

Legitimate ways to grow real coverage instead: more public sanctions lists beyond OFAC (UK OFSI,
EU, UN, Canada's SEMA — same ingestion-script pattern as `ingest-ofac-sdn.ts`), public
post-incident reports from security firms (CertiK/SlowMist/PeckShield publish hacker wallet
addresses in their own public writeups — citable), publicly-published exchange/protocol hot
wallet disclosures, and — the actual long-term engine — the Community label pipeline itself.

## Consequences

- `Label` needs a new field for moderation status (e.g. `reviewStatus: "community" | "confirmed"`)
  distinct from `confidence`. A private label is a separate concept entirely — likely its own
  per-user store, not a field on the shared `Label` type, since it's never meant to merge into the
  shared dataset by default.
- Needs real auth before any of this ships — can't be faked or skipped to "get to the feature
  faster." Scope this as its own build phase.
- The moderation/"who can confirm a label" question (who are the mods, how is that granted) isn't
  decided yet — flag as open when that work starts.

## What would change this decision

If the self-attestation signature-proof design gets built properly later, it slots in as tier 3
without touching tiers 1–2. If accounts/auth end up needing a specific provider choice (e.g.
something OAuth-based vs a custom system), that's a separate ADR when that work starts.
