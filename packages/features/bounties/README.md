# @osstrace/bounties

A public bounty board: anyone — technical or not — can open a bounty by writing an in-depth
feature spec and naming their own reward; anyone can submit a PR against it; a moderator records
which submission wins. See [ADR 0009](../../../docs/adr/0009-bounty-program-v1-is-tracking-only.md)
before reading further — it's the reason this package looks the way it does.

**This system never holds, escrows, or moves a reward.** `Bounty.reward` is free text, exactly as
the poster wrote it ("100,000 tokens", "$500, token TBD") — never parsed as a currency amount,
never validated against a real asset. The actual payout happens off-platform, between the bounty's
opener and whoever's submission a moderator marks as the winner. This is a tracker, not a bank.

**One real capability on top of that ([ADR 0020](../../../docs/adr/0020-bounty-funding-via-verified-on-chain-deposits.md)):
a verified on-chain deposit.** Anyone logged in can back a bounty by sending real SOL/ETH/an SPL
or ERC-20 token to this project's own configured wallet, then submitting the transaction's
signature/hash on that bounty's page. The server independently re-verifies that exact transaction
via real RPC — it never trusts the submitter's claim about amount or asset. This still isn't
escrow: nothing here can release funds, and a deposit is recorded as having arrived, never as a
promise about when or whether it leaves. Correlation is "your account says this tx funds this
bounty," not a memo — see the ADR for why.

## Running it

```sh
npm run dev --workspace packages/features/bounties
# or, from the repo root:
npm run dev:bounties
```

Reads the root `.env` (`BOUNTIES_PORT`, default **5313**; `BOUNTIES_PATH`; `BOUNTIES_ALLOWED_ORIGINS`,
falling back to `ACCOUNTS_ALLOWED_ORIGINS`; `BOUNTIES_RECEIVING_WALLET_ETHEREUM` /
`BOUNTIES_RECEIVING_WALLET_SOLANA`, public addresses only, each chain left blank simply can't take
deposits yet; `SOLANA_RPC_URL` / `ETH_RPC_URL`, same vars every other feature already uses). Needs
the accounts API's store to exist (same file, same sessions) — run `npm run dev:accounts` alongside it.

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
GET  /bounties/wallets            (public)                          → 200 { wallets }
GET  /bounties/:id/deposits       (public)                          → 200 { deposits }
POST /bounties/:id/deposits       (Bearer)              { chain, txRef } → 201 { deposit }
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

`GET /bounties/wallets` returns only the public addresses configured by env var — never a key,
and `{}` for a chain with none set. Recording a deposit: `{ chain: "ethereum" | "solana", txRef }`,
Bearer-authenticated (anyone, not just the opener), at any point in a bounty's life — funding never
changes its `open`/`claimed`/`cancelled` status. The server verifies `txRef` itself via real RPC
before recording anything; a transaction already recorded against any bounty is refused
(`already_recorded`, naming which one). `Deposit.memo` is present only when the transaction carried
a real Solana Memo program instruction — a visible cross-check, never required or verified as
matching the bounty.

## What's not built yet

- **No actual payout, escrow, or token.** See ADR 0009 — a deliberate v1 scope decision, not a gap.
- **No price conversion or reward matching.** A deposit is shown in its own real asset/amount —
  never converted to a dollar figure or compared against the opener's free-text `reward` claim.
- **No dispute process beyond "a moderator picks one submission."** If two submissions both
  plausibly match a spec, there's no structured review step beyond a moderator's judgment call,
  and no appeal path if a poster or submitter disagrees with it.
- **No rate limiting** on opening bounties or submitting PRs.
- **No automatic PR status checking.** A submitted `prUrl` is never fetched (SSRF risk) — a
  moderator checks it manually before claiming.

## Testing

`npm test` runs `tests/service.test.ts` (the real service, over real temp-file accounts + bounty
stores — real signups, real argon2 hashing, a real promoted moderator), `tests/http.test.ts` (the
same thing over real HTTP on an ephemeral port), and `tests/deposits.test.ts` (the real on-chain
verification logic, against real recorded mainnet transactions served back by a local stand-in
RPC server — never a fabricated transaction shape). Covers: opening, public listing/reading with
no login, submitting, a non-moderator refused from claiming, claiming marking the winner accepted
and every other pending submission rejected, a claimed bounty refusing further submissions or a
second claim, cancelling by the opener or by a moderator (and refusing an unrelated user), a
required cancellation reason, status filtering, CORS allow-listing, and the full deposit flow:
real Solana native/SPL and Ethereum native/ERC-20 verification (including a real spl-memo
instruction and its absence), idempotency across bounties, an unconfigured chain, and every
verification-failure reason mapped to its own status code.
