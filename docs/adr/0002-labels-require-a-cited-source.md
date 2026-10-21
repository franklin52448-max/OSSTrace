# ADR 0002 — Every label and tag requires a cited source

Status: Decided 2026-10-21

## Context

This project cannot replicate Arkham's (or any similar platform's) actual proprietary labelset —
years of investigation work and a 3.9-billion-row attribution database aren't something a new
open-source project can shortcut to. The honest options were: ship with no data at all, ship with
plausible-looking placeholder data, or ship a small amount of genuinely real, checkable data.

Shipping placeholder/fabricated labels was never on the table — this workspace has a hard rule
against shipping mock/fake data presented as real, and for a project whose entire value
proposition is "you can check our work," fabricated data would be actively worse than no data.

## Decision

The `Label` and `Tag` types in `packages/core/src/types.ts` each require a non-optional `source:
Source` field (`{ description, url, addedAt }`). There is no constructor path, store method, or
ingestion script that can create a Label or Tag without one — this is enforced by the type system,
not just requested in `CONTRIBUTING.md`.

The seed labelset ships with exactly one real source: the U.S. Treasury OFAC Specially Designated
Nationals (SDN) list's digital-currency-address entries, which is public, free, authoritative, and
directly machine-readable. See `data/labels/README.md`.

## Consequences

- The initial labelset is small. That's a deliberate, disclosed tradeoff (see the README status
  table), not a bug to be quietly worked around by loosening the source requirement.
- Every future label source (exchange-published hot wallet disclosures, protocol docs, on-chain
  heuristic clustering with a documented methodology, etc.) must produce a real `url` or named
  document per entry before it can be ingested.
- A clustering/heuristic-derived label (lower confidence, no single citable document) still needs
  a `Source` — in that case, `description` should name the heuristic/methodology itself (e.g.
  "common-input-ownership clustering, see docs/methodology/clustering.md") so it's at least
  checkable and reproducible, even without an external URL.

## What would change this decision

Nothing should. If a future contribution needs an exception, that's a sign the `Source` type needs
a new variant (e.g. a `methodology` source kind distinct from a `document` source kind) — not a
reason to make the field optional.
