# ADR 0005 — The public labeled database is the goal, not a side effect

Status: Decided 2026-10-21

## Context

ADR 0004 ruled out scraping Arkham (or any similar proprietary platform) as a label source — it's
a ToS/legal risk and it undermines the sourcing guarantee that's this project's entire value. That
decision needs a positive counterpart: what this project is actually trying to build instead, so
"we can't take the shortcut" doesn't quietly turn into "so we gave up on coverage."

## Decision

**The goal is to build and keep public, forever, the largest openly-licensed labeled
wallet/entity database that exists** — every entry real, every entry sourced, free for anyone
(a researcher, another project, a company, a government) to use without asking permission. Not a
feature of this project. The point of it.

This is achievable without ever touching Arkham's data, from sources that are already legitimate
and already public:

1. **More government sanctions lists**, same pattern as `ingest-ofac-sdn.ts`: UK OFSI, EU, UN,
   Canada's SEMA, and others as they're found. Each is its own small ingestion script, same shape.
2. **GitHub-published open address lists** — exchange- and protocol-published hot wallet
   addresses that are already public (many protocols and exchanges publish their own treasury/hot
   wallet addresses, and the open-source community already maintains some lists of these). Used
   first to label the biggest, most-looked-up exchanges and already-public addresses — the entries
   that get the most lookups and are least controversial to source, a good place to build real
   coverage fast.
3. **Public post-incident security reports** (CertiK, SlowMist, PeckShield, and similar) — they
   publish hacker/exploit wallet addresses in their own public writeups after an incident; each is
   individually citable.
4. **The community contribution pipeline** (ADR 0004) — the biggest long-term source by volume,
   once accounts/moderation exist. Every Community/Confirmed label added by a real person with a
   real citation grows the same public dataset.

Every source above produces the same thing: a `Label`/`Tag` with a real `source.url`, ingested the
same documented way, landing in the same dataset.

## Consequences

- The label dataset (`data/labels/`) is the product in the same sense the code is — treat growing
  it with the same rigor as a feature (ADR 0002's sourcing rule applies identically regardless of
  which of the four source types above an entry came from).
- "Largest public labeled database" is a long-horizon goal, not a near-term deliverable — today's
  89-address seed is a first source (#1 above) proving the pipeline works, not the destination.
- A future "which GitHub-published address list is a scraped copy of Arkham's data vs. genuinely
  independent and public" judgment call will come up. When it does: if the underlying list is
  itself sourced from Arkham (even indirectly, via a repo that scraped Arkham), it's out of
  bounds per ADR 0004 — the test is where the *data* originates, not where we found the file.

## What would change this decision

Nothing about the goal itself. Which specific lists/sources get ingested next is an ongoing,
evolving decision — add new sources as ingestion scripts following `ingest-ofac-sdn.ts`'s shape,
no new ADR needed per source unless the source itself raises a new category of question (like a
new trust-tier, or a new legal question) the way Arkham's data did.
