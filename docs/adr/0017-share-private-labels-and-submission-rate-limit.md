# ADR 0017 — Sharing a private label as a Community label

Status: Decided 2026-10-22 (implemented in `packages/features/community-labels/` and `packages/web/`)

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
