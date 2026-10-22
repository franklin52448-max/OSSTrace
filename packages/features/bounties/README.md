# @osstrace/bounties

A public bounty board: anyone — technical or not — can open a bounty by writing an in-depth
feature spec and naming their own reward; anyone can submit a PR against it; a moderator records
which submission wins. See [ADR 0009](../../../docs/adr/0009-bounty-program-v1-is-tracking-only.md)
before reading further — it's the reason this package looks the way it does.

**This system never holds, escrows, or moves a reward.** `Bounty.reward` is free text, exactly as
the poster wrote it ("100,000 tokens", "$500, token TBD") — never parsed as a currency amount,
never validated against a real asset. The actual payout happens off-platform, between the bounty's
opener and whoever's submission a moderator marks as the winner. This is a tracker, not a bank.

## Running it

```sh
npm run dev --workspace packages/features/bounties
# or, from the repo root:
npm run dev:bounties
```

Reads the root `.env` (`BOUNTIES_PORT`, default **5313**; `BOUNTIES_PATH`; `BOUNTIES_ALLOWED_ORIGINS`,
falling back to `ACCOUNTS_ALLOWED_ORIGINS`). Needs the accounts API's store to exist (same file,
same sessions) — run `npm run dev:accounts` alongside it.

## How it plugs in

Same shape as `@osstrace/community-labels` and `@osstrace/private-labels`: identity and roles come
entirely from `@osstrace/accounts` (`authenticate`/`requireRole`/`roleAtLeast`), re-checked on
every call, so a demoted moderator loses claim rights on their very next request. A
`JsonFileBountyStore` (same concurrency contract as the community-labels submission store:
re-reads every call, serializes writes, atomic rename) holds both bounties and their submissions
in one file.

## API

```
POST /bounties                    (Bearer)                     body → 201 { bounty }
GET  /bounties?status=…           (public)                          → 200 { bounties }
GET  /bounties/:id                (public)                          → 200 { bounty }
GET  /bounties/:id/submissions    (public)                          → 200 { submissions }
POST /bounties/:id/submissions    (Bearer)                     body → 201 { submission }
POST /bounties/:id/claim          (Bearer, moderator)     { submissionId } → 200 { bounty }
POST /bounties/:id/cancel         (Bearer, opener or moderator) { reason } → 200 { bounty }
```

Listing bounties and a bounty's submissions needs no login — it's a public board, same posture as
labels, the graph, and Tracer elsewhere in this project. Opening a bounty or submitting a PR needs
a real session. Claiming needs `moderator` or `admin`. Cancelling an open bounty needs to be either
the bounty's own opener, or a moderator/admin — see ADR 0009 for why a moderator records the claim
rather than the opener alone with no check.

Opening a bounty: `{ title, description, reward }`, all required. `description` has a real
minimum length (40 characters after whitespace collapsing) — "in depth" is the premise of the
feature, not a suggestion. Errors are `{ "error": "<code>", "message": "..." }`; see `src/http.ts`
for the exact status code per error.

## What's not built yet

- **No actual payout, escrow, or token.** See ADR 0009 — a deliberate v1 scope decision, not a gap.
- **No dispute process beyond "a moderator picks one submission."** If two submissions both
  plausibly match a spec, there's no structured review step beyond a moderator's judgment call,
  and no appeal path if a poster or submitter disagrees with it.
- **No rate limiting** on opening bounties or submitting PRs.
- **No automatic PR status checking.** A submitted `prUrl` is never fetched (SSRF risk) — a
  moderator checks it manually before claiming.

## Testing

`npm test` runs `tests/service.test.ts` (the real service, over real temp-file accounts + bounty
stores — real signups, real argon2 hashing, a real promoted moderator) and `tests/http.test.ts`
(the same thing over real HTTP on an ephemeral port). Covers: opening, public listing/reading with
no login, submitting, a non-moderator refused from claiming, claiming marking the winner accepted
and every other pending submission rejected, a claimed bounty refusing further submissions or a
second claim, cancelling by the opener or by a moderator (and refusing an unrelated user), a
required cancellation reason, status filtering, and CORS allow-listing.
