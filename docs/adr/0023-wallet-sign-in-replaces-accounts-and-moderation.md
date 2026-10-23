# ADR 0023 — Wallet sign-in replaces email+password accounts; roles and label moderation are removed

Status: Decided 2026-10-22 (implemented in `packages/server/src/auth/`, `packages/web/src/AccountPanel.tsx`/`walletConnect.ts`). Supersedes ADR 0006 and ADR 0007.

## Context

ADR 0006 built self-hosted email+password accounts with `user < moderator < admin` roles, and
explicitly considered and rejected wallet sign-in at the time: "this project is read-only/
observational and never touches signing... proving wallet ownership is ADR 0004's deferred tier 3
and deserves its own security design, not a login mechanism bolted on here." ADR 0007 then built
the Community/Confirmed label-tier submission-and-moderator-review pipeline on top of those roles.

Both were built against the *old* per-feature-service architecture (`packages/features/accounts`,
`packages/features/community-labels`). ADR 0022's unified-server rewrite (`packages/server`,
`packages/web`) did not carry either forward — not as an oversight, but because the operator
re-decided the login question directly, for reasons specific to this project:

- An on-chain intelligence tool's core audience already holds a wallet to interact with the chains
  it reports on. Asking that same visitor to additionally invent and remember a password is the
  friction, not the safety net ADR 0006 assumed it would be for a general audience.
- A wallet address is also a more useful identity for this specific product than an email: it's
  the same kind of thing every other piece of data in the app is about (addresses, balances,
  transfers), and it's inherently public and self-verifying — no email-verification step was ever
  built under ADR 0006 (explicitly deferred), so email addresses here were never actually proven
  to belong to their owner anyway.
- Removing passwords removes an entire class of this project's own risk (hashing, credential
  storage, password reset) for a product that was never going to run its own mail sending.

## Decision

### 1. A user is a `(chain, walletAddress)` pair; there is no password

`POST /api/auth/challenge` issues a single-use, 5-minute nonce message (and returns the nonce
alongside it); the wallet signs it client-side (Phantom's `signMessage`, or MetaMask's
`personal_sign`). `POST /api/auth/verify` takes that nonce back to find the pending challenge,
which must have been issued for the same chain and address. Pending challenges are keyed by nonce,
not by address (changed 2026-10-23): keyed by address, anyone could request a fresh challenge for
someone else's wallet and invalidate the one its owner was signing, and the per-address challenge
cap that was meant to limit that let anyone burn a wallet's hourly allowance instead. Challenges are
now rate-limited per IP only. `POST /api/auth/verify` checks the signature (tweetnacl for Solana's ed25519, `ethers.verifyMessage` for Ethereum's
secp256k1/EIP-191), then finds-or-creates the account and sets the same kind of httpOnly session
cookie the unified server already used. The Ethereum challenge message is EIP-4361 ("Sign-In with
Ethereum") formatted, so MetaMask and similar wallets render it as a trusted sign-in request
instead of a generic message-signing warning; Solana's uses Phantom's plain `signMessage`
convention (Phantom's own structured `signIn()`/SIWS API was evaluated and deliberately not
adopted yet — it needs a second, different signature-verification path this hasn't been built and
verified for; see the commit history around `packages/server/src/auth/wallet.ts` for the specifics
of that call).

Display name is the only identity field a signed-in user can still set (`PATCH /api/settings`) —
there is no username/email to manage.

### 2. No roles. `user`/`moderator`/`admin` do not exist in the new server.

A wallet address has no natural "moderator" analogue, and nothing in the unified server's current
feature set needs one: Bounties (ADR 0020, ported to the unified server this session) resolves
authorization by the simplest rule that still matches its own intent — a bounty's opener, not a
separately-appointed role, decides its outcome.

### 3. The Community/Confirmed label-tier submission-and-review pipeline (ADR 0007) is not carried
forward. The new Labels feature (`packages/web/src/labels/`, `packages/server`'s label routes) is
a simpler entities/tags/labels model with no `reviewStatus`, no public submission queue, and no
moderator review step. The `Moderation` view (`packages/web/src/ModerationView.tsx`) was deleted
outright, not hidden — there is currently no replacement for public community-sourced label
submission on this server. Whether and how to rebuild something like it (with or without a
moderation concept) is open and not decided here.

## Consequences

- `packages/server/src/auth/password.ts` is deleted; the `password_hash` column was dropped from
  the database (migration `002_wallet_auth.sql`) rather than kept nullable, since nothing reads it
  anymore and node:sqlite's `DROP COLUMN` works without a table rebuild.
- The old `packages/features/accounts` and `packages/features/community-labels` packages are
  **not** deleted — they're kept running only because specific tests (`lookupRace.test.ts` and
  others, see those test files' own doc comments) deliberately exercise retired web components
  against them for real coverage that has no equivalent against the new server yet. They are not
  reachable from the live site's navigation and should not be read as describing current
  architecture.
- ADR 0006 and ADR 0007 are marked superseded by this ADR (see their Status lines) rather than
  edited, per this project's normal practice of ADRs as a historical record. Their decisions were
  correct for the old architecture; this ADR documents why the new one made a different call, not
  that the old one was a mistake.

## What would change this decision

- **Real contributor/operator demand for a non-wallet login path** (e.g. a visitor who wants to
  use the labeling/bounty features without ever connecting a wallet) would need its own ADR — the
  current design has no email/password fallback at all, by choice, not by omission.
- **Rebuilding community-sourced label submission** with real review would need to re-decide who
  reviews and how that authority is granted — ADR 0006 §6's reasoning (CLI-granted first admin,
  rejected the "first signup" and "bootstrap env var" alternatives) is still the relevant prior
  art for that question even though the role system itself is gone; a new design could reasonably
  reuse its logic (e.g. "the project operator designates reviewers," adapted to wallet addresses).
- **Phantom's `signIn()` (SIWS)** getting implemented (see §1) would bring Solana's sign-in UX to
  parity with Ethereum's EIP-4361 trusted-request treatment; it's a well-scoped, independent
  follow-up, not blocked on anything else in this ADR.
