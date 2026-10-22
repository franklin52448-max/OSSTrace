# ADR 0017 — Sharing a private label as a Community label, and a submission rate limit

Status: Decided 2026-10-22 (implemented in `packages/features/community-labels/` and `packages/web/`)

Two community-label decisions made together, because both change the one path that creates a
submission. Part A is the share flow. Part B is the per-account rate limit ADR 0007 deferred.
Self-attested labels (ADR 0004's tier 3) got their own ADR, 0018, since that one is mostly a
security design.

# Part A — Sharing a private label

## Context

ADR 0004 left a door open: "a later 'share' action could promote a private label into a
Community submission, which *would* then need a real source to pass review." Arkham, the prior
art ADR 0004 cites, has the same private-by-default-then-share model.

The catch is that the two things being joined have different rules. A private label
(`@osstrace/private-labels`) is a personal note with **no source requirement**: it's never shown
to anyone, so ADR 0002 doesn't apply to it. A Community submission (`@osstrace/community-labels`,
ADR 0007) is a public claim and **must** carry a real cited source. So a private label can't just
be copied into the public dataset.

## Decision

### 1. Sharing pre-fills a submission. It never skips the source.

"Share as Community label" takes the private label's text as the **starting name** of an ordinary
Community submission. The submitter still has to choose a `confidence` and supply a real
`source.url` + `source.description`. The share path runs the exact same `parseSubmissionInput`
(`validate.ts`) that `POST /labels/submissions` runs: there is one validator, not a second, looser
copy for shared labels. Everything a normal submission is refused for (no source, a `localhost`
URL, a bidi override in the name, a name over 120 characters — private labels allow 200) is
refused for a shared one too. The submitter can edit the pre-filled name before sharing.

Two service methods on `LabelSubmissionService`, with matching routes:

- `shareDraft(token, chain, address)` → `GET /labels/submissions/from-private-label/:chain/:address`
  returns `{ chain, address, name, confidence: null, source: null }`. Writes nothing.
- `shareFromPrivateLabel(token, body)` → `POST /labels/submissions/from-private-label` with
  `{ chain, address, name?, confidence, source }` creates the submission (201), through the same
  internal path as `submit`.

### 2. The private label is read, never modified, and stays independent

The community-labels package gets a `PrivateLabelLookup` interface with **only** `get(token,
chain, address)`. `PrivateLabelService` satisfies it, and the server hands over just that one
method. This package therefore has no way to edit or delete a private label: it's the shape of the
interface, not a promise. Sharing creates a separate submission record, and nothing links the two
afterwards. The private label stays exactly as it was, still private, whether the submission is
pending, confirmed or rejected. Deleting the private label later doesn't withdraw the public copy
either: once shared, the public claim stands on its own source.

The lookup is owner-scoped by the caller's own session token (the private-labels guarantee from
ADR 0004), so you can only ever share your own label. Asking to share an address you have no
private label for, or one only someone else labelled, gets the same `not_found`. It never reveals
whether anybody else has a private label there.

### 3. Why the share goes through the community-labels server

The submissions file has one writer, the community-labels server (ADR 0007, section 2). So the
share has to be executed there, not in the private-labels server. The community-labels server
reads the private-labels file (`privateLabelsStorePath()`, now exported by
`@osstrace/private-labels`) through a read-only `PrivateLabelService.get`. That's the same
"many readers, one writer" arrangement the accounts file already has. Only `server.ts` imports
`@osstrace/private-labels` at runtime, so the Explorer, which imports this package for
`CommunityLabelReader`, doesn't load it.

A purely client-side version, where the browser copies the text into the normal form, would also
work. It was rejected because the backend should own the guarantee: "share" means *your own*
private label, checked server-side, and the same rules apply either way.

### 4. Web UI

`PrivateLabelPanel` shows a **Share as Community label** button when you have a private label for
the address. It opens the existing `LabelSubmitForm` in share mode: the name comes from the
server's draft, the source fields are empty and required, and the copy says the private label is
unchanged. Submitting posts to the share route. The panel's footer no longer says "never shared"
because it's now true only until you choose to share.

## What would change this decision

- If private labels ever gain extra fields (notes, tags), only the name is pre-filled unless that
  field has a public equivalent with its own sourcing rule.
- A multi-instance deployment needs database-backed stores for both packages. The read-only
  lookup interface stays the same.

# Part B — Per-account submission rate limit

## Context

ADR 0007 listed rate limiting as deferred and "needed before any public deployment". Without it,
one logged-in account could script unlimited submissions. Each one is public at once (marked
unreviewed) and lands in the moderators' queue. The existing "one pending submission per account
per address" rule doesn't help, because a script just picks a new address each time.

## Decision

**At most 10 submissions per account in any rolling 60 minutes** (`SUBMISSION_RATE_LIMIT` in
`service.ts`). The 11th gets `rate_limited` (HTTP 429), with `retryAfterSeconds` in the body and a
`Retry-After` header (exposed to the allowlisted web origin through CORS), plus a message saying
how many minutes to wait. It isn't a silent drop.

Why 10 an hour:

- **A real submission is slow to make.** It needs a public source found, linked and described,
  and a confidence picked. Ten in an hour is one every six minutes, kept up for an hour, which is
  more than a careful contributor typically manages. Normal use never hits it.
- **It caps what one account can dump on the moderators.** Ten an hour, and a moderator can still
  get through that. Unlimited, the queue stops meaning anything.
- **Bulk sources don't belong in the form.** Anyone with hundreds of addresses from one publisher
  (a sanctions list, a security firm's incident report) should write an ingestion script
  (`scripts/ingest-*.ts`, ADR 0002/0004). That's citable, re-runnable and reviewable as code.
  It shouldn't be 300 form posts.

What counts: every submission the account **created** in the window, whatever its status now,
including ones later rejected. A rejection doesn't give the slot back, because the moderator's
time was spent either way. Attempts refused before anything is stored (invalid, duplicate,
unauthenticated, already rate-limited) don't count. A share (Part A) is a submission and counts
the same. Self-attested submissions (ADR 0018) count too.

The window is rolling, not a fixed clock hour, so there's no burst of 20 across an hour boundary.
A submission made exactly one window ago has just aged out.

### How it's enforced

The limit is checked **inside the submissions store's write lock**, against the stored
submissions themselves (`SubmissionStore.create(submission, { max, since })`). The alternative was
an in-memory counter in the service. It was rejected for two reasons:

- **It survives restarts.** An in-memory counter would reset to zero on every restart, so a
  restart would hand a spammer a fresh allowance. The store already holds `submittedBy` and
  `submittedAt` for every submission, so counting them adds no new state to keep in sync.
- **It can't be raced.** The count and the write happen in one critical section, the same way the
  duplicate check already does. Fifteen parallel requests get exactly ten through (tested).

The cost is one pass over the account's submissions on each create. The store re-reads the whole
file on every call anyway (ADR 0007), so this adds nothing noticeable. A database-backed store
would do it as an indexed count.

Scoped to this package: no shared rate-limit utility exists, and the accounts login limiter
(ADR 0015) has different needs (it counts failed attempts per IP and email, before anyone is
authenticated). Two consumers with different shapes is no reason for a shared abstraction yet.
`LabelSubmissionServiceOptions.rateLimit` lets a deployment override the numbers.

## What would change this decision

- If real contributors hit the limit in normal use, raise it. That would show up as `rate_limited`
  responses for accounts whose submissions are mostly confirmed. If spam gets through below it,
  lower it, or add a daily cap on top.
- Per-account limits don't stop a sockpuppet farm. Signup limits (ADR 0015) and moderation do.
  An IP-level limit on this server is a possible addition, at the reverse proxy.
