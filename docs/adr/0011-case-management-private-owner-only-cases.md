# ADR 0011 — Case management: private, owner-only cases; no admin read path

Status: Decided 2026-10-22 (implemented in `packages/features/case-management/`)

## Context

`PRD.md` and `ROADMAP.md` (Wave 3) name **Case Management** as a planned feature: "group findings
into a structured record; needs accounts (who owns a case)". Accounts now exist (ADR 0006), so
this is buildable. Four things had to be decided before writing any code:

1. What a case and its contents look like as data.
2. Who can see a case — the owner only, some sharing model, or public like the bounty board.
3. What anyone *other* than the owner may do to a case — including admins and moderators.
4. What happens to a case's contents when it's closed.

The two closest precedents in this repo point in opposite directions. The **bounty board** (ADR
0009) is public by design: a bounty is a request addressed to everyone. **Private labels** (ADR
0004) are strictly private: one person's own note about an address, never shown to anyone else.
A case has to land on one side of that line on purpose, not by whichever template got copied.

## Decision

### 1. Data model: two collections in one file, items reference their case by id

- **`Case`**: `{ id, title, description, ownedBy, status: "open" | "closed", createdAt,
  updatedAt, closedAt }`. `ownedBy` is the accounts package's opaque user id, never an email (ADR
  0006 §7). `closedAt` is `null` while the case is open. `updatedAt` moves on *any* change to the
  case, including adding, editing or removing an item, so "most recently worked on" sorts
  correctly.
- **`CaseItem`**: `{ id, caseId, ownedBy, chain, address, note, addedAt, updatedAt }` — one real
  address on one supported chain, plus the investigator's own free-text note about why it's in the
  case.

Items are a **separate collection referencing `caseId`**, not an array embedded in the case
record. Same precedent as `Bounty` / `BountySubmission` in ADR 0009: items are added, edited and
removed independently of the case's own fields, and an embedded array would make every item
change a rewrite of the case object. Both collections live in **one file**
(`data/private/cases.json`) because a case and its items are always read and written together,
and one file means one atomic rename covers "delete a case and all its items" — there's no window
where items exist without their case.

Each item **also carries `ownedBy`**, duplicated from its case. That's deliberate redundancy: the
store filters items by owner *and* case id, so an item can never be returned for the wrong owner
even if a bug elsewhere ever produced a case id collision or a mismatched lookup.

**Addresses** are validated with `isRealAddress` and stored in `canonicalAddress` form from
`@osstrace/core` — exactly the checks community-labels and Tracer use, not a third copy of the
regexes. A malformed address is refused (so a typo can't become a finding nobody can ever look up
again); an Ethereum address is lowercased (checksum case isn't identity), a Solana one kept exact
(base58 is case-sensitive). **One case holds an address at most once** — a second add of the same
`(chain, address)` is refused (`duplicate_item`), and the existing item's note is edited instead.
Two items for the same address in one case would just be two halves of one note.

A note **may be empty** (sometimes the finding is "this address belongs in this case", full
stop) and may span multiple lines; a title is one line. No source is required on a note or a case
— for the same reason ADR 0004 exempts private labels from ADR 0002: a case is not a public claim
and never enters the shared label dataset.

### 2. Visibility: private to its owner, full stop — no sharing in v1

A case is visible **only to the account that created it**. There is no public case, no
"share with a teammate", no read-only link.

Why private, rather than public like bounties:

- **A case is an investigator's working notes, not a publication.** It groups addresses the
  investigator *suspects* are connected, with notes that are often unverified hunches ("same
  funding pattern as the drainer from last week?"). Publishing that by default would turn this
  project into a place where unsourced accusations about real addresses are public — the exact
  thing ADR 0002 exists to keep out. Public, sourced claims already have a path: Community label
  submissions (ADR 0007), which require a cited source and moderator review.
- **Open investigations leak value when they're visible.** If the subject of an investigation
  can watch the case being built, they can move funds before it's finished. Arkham's own model
  (custom labels/entities private by default, explicit share action — the prior art ADR 0004
  already cites) reflects the same reality.
- **It's consistent with ADR 0004's reasoning and FEATURE_GUIDELINES' "no logging of what users
  search for".** Which addresses an investigator is grouping together is a stronger signal of
  their work than any single lookup. A transparency tool that exposes its own investigators'
  working sets undermines the reason it exists.

Why no sharing model in v1, rather than building one now:

- Sharing needs decisions that have no answer yet and are expensive to reverse once data exists:
  per-case collaborators vs teams/organizations, read-only vs edit, whether a collaborator's
  added items belong to them or to the case owner, what happens on revocation, and whether
  sharing is by account id or by email (emails are unverified — ADR 0006, "Deferred"). Getting
  any of that wrong after people have shared real investigations is a privacy incident, not a
  refactor.
- Private-only is the safe default to *add* sharing to later: the data model already records
  `ownedBy` on every case and item, so a later `collaborators` field (or a separate grants
  collection) is additive. Going the other way — un-sharing data that was shared by default — is
  not possible.

### 3. Who can do what to someone else's case: **nobody**, including admins and moderators

Every operation — read, list, edit, add/edit/remove an item, close, reopen, delete — is
performed **as the authenticated owner only**. There is no admin or moderator path, over HTTP or
in the service, to read or change another user's case.

This was weighed against an "admins can read/delete for moderation" exception and rejected:

- **Moderation exists for public content.** ADR 0007's moderators review Community labels
  because those are shown to everyone; ADR 0009's moderators adjudicate bounties because those are
  a public agreement between two parties. A private case is shown to nobody, so there is no
  audience to protect and nothing to moderate. A moderator power with no moderation need is just
  surveillance capability.
- **It would make every investigator's private notes readable by whoever holds `admin`.** ADR
  0006 deliberately separates "who can confirm labels" from "who can grant roles" so that a
  moderation power doesn't silently grow; an admin read path into private investigations is a
  much larger power than either, and ADR 0006 never granted it. Private labels (ADR 0004) have no
  admin read path either; cases hold the same kind of data and get the same rule.
- **The operator already has the file.** Anyone with shell access to the machine holding
  `data/private/cases.json` can read it, exactly as with the accounts and private-labels files.
  That's the honest trust model of a self-hosted JSON store, stated plainly, not an API feature.
  Legal or abuse requests (e.g. a court order) are an operator-level matter, handled outside the
  API — the same way they would be for the accounts file.

**Another user's case is indistinguishable from a case that doesn't exist.** Every lookup of a
case id that isn't yours returns `404 not_found` — never `403` — so the API can't be used as an
oracle for "does case id X exist, and is it someone else's?". The store interface makes this
structural: every method takes the owner id, there is no "get by id" without an owner, and an
empty owner id throws instead of acting as a wildcard (same shape as `PrivateLabelStore`).

### 4. Closing a case freezes it; reopening unfreezes it; deleting is always allowed

- **Close** marks an open case `closed` and sets `closedAt`. A closed case is **read-only**:
  title/description edits and item add/edit/remove are refused with `409 case_closed` until it's
  reopened. Closing means "this investigation is finished"; a finished record that keeps
  silently changing isn't finished.
- **Reopen** turns a closed case back to `open` and clears `closedAt`. Closing an already-closed
  case, or reopening an open one, is refused (`409`) rather than silently treated as success, so
  the client can't believe it changed something it didn't.
- **Delete** removes the case **and all its items** in one atomic write, whether the case is open
  or closed — it's the owner's own data. There's no soft delete or trash; the API says so.

### Limits

Per account: at most **500 cases**; per case, at most **1,000 items**. Both are counted inside the
store's write lock, so concurrent creates can't overshoot together. They bound how large the
re-read-on-every-call JSON file one account can grow, far above any real single investigator's
need, same reasoning as private labels' 5,000-label cap. Title ≤ 140 characters (one line),
description ≤ 8,000, note ≤ 2,000 (code points, after trimming).

## Consequences

- A case can never reach the Explorer response, the label dataset, the graph, or any other user.
  Sharing a finding publicly means submitting it as a sourced Community label — the existing,
  reviewed path.
- One more private per-user file (`data/private/cases.json`, `0600`, git-ignored) for an operator
  to protect, under the same trust model as the accounts and private-labels files.
- Same one-writer limit as every other JSON store in this repo: one server process writes the
  file. A multi-instance deployment needs a database-backed `CaseStore` (same interface).
- Account deletion doesn't exist yet (ADR 0006, "Deferred"). When it does, it must delete that
  user's cases and items too — written into the package README as a requirement for that work.

## What would change this decision

- **Real demand for team investigations** → a sharing ADR: explicit, per-case grants to named
  accounts, owner-revocable, with the read/edit and item-ownership questions above answered. Not
  a flag flip on this one.
- **A "publish this case" request** → it should become a *submission* (each item to the
  community-labels pipeline with a real source), not a public case, so ADR 0002 still holds.
- **A real legal/abuse process for hosted instances** → that's an operator-policy document for a
  hosting target, not an admin API route; if it ever needs tooling, it's an operator CLI (like
  `set-role`), never an HTTP endpoint.
