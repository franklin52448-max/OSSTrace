# @osstrace/community-labels

Lets people add labels, and lets moderators review them. This is ADR 0004's tiers 1–2, and the
design is in [ADR 0007](../../../docs/adr/0007-community-label-submissions-and-review.md).

- Any logged-in user can **submit** a label for an address. A cited source (URL + description) is
  required, just as it is for every label in this project ([ADR 0002](../../../docs/adr/0002-labels-require-a-cited-source.md)).
- It's public right away as a **Community** label (`reviewStatus: "community"`), marked unreviewed.
- A **moderator** (or admin) reviews it. **Confirm** makes it a Confirmed label
  (`reviewStatus: "confirmed"`, shown with a ✓ CONFIRMED badge). **Reject**, which needs a reason,
  removes it from public view. Moderators can't review their own submissions.
- Or a user who controls the address **self-attests** it: they sign a server-issued statement with
  the address's own key, and it's public as a **Self-attested** label
  (`reviewStatus: "self-attested"`, [ADR 0019](../../../docs/adr/0019-self-attested-labels.md)).
  That proves control of the address, not that the name is true.

Identity and roles come from [`@osstrace/accounts`](../accounts/README.md) (`authenticate`,
`requireRole(token, "moderator")`). Nothing here re-implements auth.

## Running it

```sh
npm run dev:community-labels        # from the repo root
```

The server listens on `COMMUNITY_LABELS_PORT` (default 5311) and needs the accounts API running too
(`npm run dev:accounts`, 5310). Both read the same accounts file, so a session from one is valid on
the other. Submissions are stored in `data/community/submissions.json` (git-ignored), or wherever
`COMMUNITY_LABELS_PATH` points. Browser access is allowed from `COMMUNITY_LABELS_ALLOWED_ORIGINS`
(default `http://localhost:5301`).

To make someone a moderator, an admin uses `PUT /accounts/users/:id/role`. The first admin is
promoted by the operator CLI (see the accounts README).

## API

JSON in, JSON out. Authenticated routes take `Authorization: Bearer <token>`. Errors look like
`{ "error": "<code>", "message": "..." }`.

| Route | Auth | Body | Success |
|---|---|---|---|
| `POST /labels/submissions` | bearer | `{ chain, address, name, confidence, source: { url, description } }` | `201 { submission }` |
| `GET /labels/submissions/mine` | bearer | none | `200 { submissions }`, your own, newest first, any status (rejections include `rejectionReason`) |
| `GET /labels/submissions?status=community\|confirmed\|rejected\|self-attested` | bearer, moderator | none | `200 { submissions }`, oldest first, default `community` (the queue) |
| `POST /labels/submissions/:id/confirm` | bearer, moderator | none | `200 { submission }` |
| `POST /labels/submissions/:id/reject` | bearer, moderator | `{ reason }` | `200 { submission }` |
| `GET /labels/submissions/from-private-label/:chain/:address` | bearer | none | `200 { draft }`: your own private label's text as `name`, `confidence` and `source` null |
| `POST /labels/submissions/from-private-label` | bearer | `{ chain, address, name?, confidence, source }` | `201 { submission }`: shares your private label (its text unless `name` is given), same validation as `POST /labels/submissions` |
| `POST /labels/submissions/self-attested/challenge` | bearer | `{ chain, address, name }` | `201 { challenge: { nonce, scheme, message, expiresAt } }`: the exact statement to sign |
| `POST /labels/submissions/self-attested` | bearer | `{ nonce, signature }` | `201 { submission }` with `status: "self-attested"` |

### Self-attesting an address you control

[ADR 0019](../../../docs/adr/0019-self-attested-labels.md) has the full design. Ask for a challenge
for your address and label, sign `challenge.message` with that address's key, then send back the
nonce and signature:

- **Ethereum**: EIP-191 `personal_sign` (what MetaMask etc. produce). 65-byte `0x…` r‖s‖v hex.
  EOAs only, no EIP-1271 contract wallets yet.
- **Solana**: wallet `signMessage` (Ed25519 over the UTF-8 message). 64-byte signature, base58.

The server verifies the signature against its own copy of the message (`verifySelfAttestation`,
exported). Challenges are single-use, expire after 10 minutes and belong to the account that asked
for them. The label carries `attestation: { scheme, message, signature }` so anyone can re-check
it. Lookups rank it after confirmed and community labels: it proves who's speaking, not that the
name is true. Moderators can reject one but not confirm it (`not_confirmable`). There's no
wallet-connect UI yet, so today you sign with your own wallet or tooling. `SELF_ATTESTATION_DOMAIN`
(default `localhost:5301`) is the site name on the first line of the statement.

### Sharing a private label

"Share as Community label" ([ADR 0017](../../../docs/adr/0017-share-private-labels-and-submission-rate-limit.md))
turns one of your own private labels into a normal Community submission. The private label only
pre-fills the name. You still need a confidence and a real source, checked by the same
`parseSubmissionInput` as every submission. The server reads your private label through a
read-only `PrivateLabelLookup` (just `get`, owner-scoped by your token), so sharing can't change or
delete it, and the private label stays as it is whatever happens to the submission. `server.ts`
reads the private-labels file at `PRIVATE_LABELS_STORE_PATH` (default
`data/private/private-labels.json`), the same file the private-labels server writes.

```sh
curl -X POST localhost:5311/labels/submissions -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{
    "chain": "ethereum",
    "address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "name": "vitalik.eth (Vitalik Buterin)",
    "confidence": "verified",
    "source": { "url": "https://app.ens.domains/vitalik.eth",
                "description": "ENS: vitalik.eth resolves to this address" }
  }'
```

Field rules:

- `chain` is `ethereum` or `solana`, and `address` must be a well-formed address for that chain.
  Ethereum addresses are stored lowercase.
- `name` can be up to 120 characters.
- `confidence` is `verified` when the source states the claim outright, or `predicted` when the
  claim is inferred from the source.
- `source.url` must be an absolute http(s) URL with a real, public host and no credentials:
  `localhost`/`*.localhost`/`*.local`/`*.internal`, loopback, private and link-local IPs, and IPv6
  literals are refused, since nobody but the submitter could open them to check the claim. The
  server never fetches it, and a moderator checks it.
- `source.description` can be up to 500 characters.
- `name`, `source.description` and a rejection `reason` must be plain text: control characters
  and Unicode text-direction controls (e.g. U+202E) are refused, since a community label is public
  before review and a direction override would make it display as different text.
- `source.addedAt` is set by the server to the submission date.

Error codes:

| Status | Codes |
|---|---|
| 400 | `invalid_submission` (any field rule above, or a missing rejection reason), `invalid_attestation` (unknown, expired or used challenge, or a signature that doesn't verify), `bad_request` (malformed JSON) |
| 401 | `unauthenticated` |
| 403 | `forbidden` (not a moderator), `own_submission` |
| 404 | `not_found` (also: no private label of yours to share for that address) |
| 409 | `duplicate_submission` (you already have one pending for this address), `already_reviewed`, `not_confirmable` (confirming a self-attested label) |
| 413 | `bad_request` (body over 16 KiB) |
| 429 | `rate_limited`: more than 10 submissions from your account in the last hour. The body has `retryAfterSeconds` and there's a `Retry-After` header |

### Rate limit

Each account can create at most **10 submissions in any rolling hour** (`SUBMISSION_RATE_LIMIT`,
[ADR 0017](../../../docs/adr/0017-share-private-labels-and-submission-rate-limit.md)). Every
created submission counts, including shares and ones later rejected. Refused attempts (invalid,
duplicate) don't. It's counted from the submissions file inside the store's write lock, so it
survives a restart and parallel requests can't race past it.

## How it plugs in

- **Lookups.** The Explorer's `buildLabelStore()` (which the Visualizer reuses) adds
  `CommunityLabelReader` as a read-only lower-priority reader of `CompositeLabelStore`. An ingested
  official label always wins for the same address. Otherwise a lookup shows the newest confirmed
  submission, then the newest unreviewed one, then the newest self-attested one. Rejected
  submissions never appear. Labels are re-read on every lookup, so a decision shows up immediately
  even when the chain data comes from cache.
- **The label shape** is `CommunityLabel` / `ConfirmedLabel` / `SelfAttestedLabel` in `@osstrace/core`. Ingested labels
  (`IngestedLabel`) have no `reviewStatus` at all. ADR 0007 explains why.
- **Mounting elsewhere.** `createLabelSubmissionsHandler(service)` returns `false` for other paths,
  so it can share a server with `createAccountsHandler`.

Import from `@osstrace/community-labels` only.

## What's not built yet

- Pending submissions can't be edited or withdrawn, and a confirmed label can't be un-confirmed. A
  newer confirmed submission for the same address does supersede it.
- A lookup shows one label per address. Other pending submissions for that address are only visible
  in the moderator queue.
- Community submissions can't add tags.
- Confirmed labels aren't exported into the open `data/labels/` dataset yet. That needs a
  contributor licensing decision first.
- Only one process should write the submissions file. Running several instances needs a
  database-backed `SubmissionStore`.
- No wallet-connect UI for self-attestation, and no EIP-1271 (contract wallet) support. See ADR 0019.

## Testing

`npm test` runs 53 tests against real things:

- real argon2 accounts in a real temp-file `JsonFileAccountStore`
- a real temp-file `JsonFileSubmissionStore`
- a real HTTP server on an ephemeral port that mounts both the accounts and the submission routes,
  called with `fetch`

Moderators are promoted through the same operator path the CLI uses. Nothing is mocked.

The tests cover:

- missing, blank, relative, `javascript:` and credentialed sources are all refused, and nothing
  invalid is written
- the stored file has the submitter's id and never their email
- plain users get 403 on the queue and on review
- a moderator can't review their own submission
- a demoted moderator loses review rights on the next request
- two concurrent reviews of one submission give exactly one decision
- ingested labels outrank community ones
- a second reader process sees new submissions immediately
- sharing a private label needs a real source, creates an independent submission, and never
  changes the private label file (checked byte for byte), using the real private-labels service
- the 11th submission in an hour is a 429, the window rolls and resets, it survives a restart, and
  15 parallel submissions land exactly 10
- `verifySelfAttestation` accepts real signatures from freshly generated in-memory secp256k1 and
  Ed25519 keypairs, and rejects a wrong key, a wrong address, a tampered message, a high-s twin and
  malformed input. It's also pinned to published vectors (RFC 8032 test 1, EIP-191
  `hashMessage("hello world")`, the address of secp256k1 key 1)
- self-attestation challenges are single-use, expire, are account-bound, and can't have lines
  injected through the label name
