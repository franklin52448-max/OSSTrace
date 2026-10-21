# ADR 0006 — Accounts and auth: self-hosted email + password, opaque sessions, CLI-granted first admin

Status: Decided 2026-10-21 (implemented in `packages/features/accounts/`)

## Context

ADR 0004 designed two things that both need real user accounts before they can exist: the
**Confirmed** label tier (someone must be authorized to confirm) and **private labels** (the
system must know whose label is whose). It left three questions explicitly open for whoever built
accounts: which provider/architecture, how sessions work, and — the governance one — who the
moderators are and how that's granted.

Constraints this decision had to satisfy:

- **No existing user base**, and no hosting target yet (PRD §10). Whatever we pick has to work on
  a contributor's laptop after `npm install` with zero extra setup, same as the rest of the repo.
- **Must be genuinely real.** No "always logged in" dev shortcut, no stubbed hashing — the
  project's hard rule against fake behavior applies to auth as much as to data.
- **Open source and self-hostable.** Anyone running their own instance has to be able to run auth
  too, without signing up for a third-party identity service.
- **Plugin-shaped**, like every other package (ADR 0001).

## Decision

### 1. Self-hosted email + password, no third-party provider (yet)

Accounts live in our own store, identified by an email address and authenticated with a password.
Considered and rejected for now:

- **OAuth / "Sign in with GitHub" / SSO** — needs a registered OAuth app, client secrets and a
  public callback URL per deployment. That's real setup friction for a first-time contributor and
  a self-hoster, for a project that has no hosting target yet. It's the most likely *addition*
  later (see "What would change this"), and the data model leaves room for it.
- **A hosted auth provider (Auth0, Clerk, Supabase Auth, …)** — makes an open-source,
  self-hostable project depend on a proprietary account and API key to run at all. Wrong fit.
- **Wallet sign-in (SIWE / sign a message)** — this project is read-only/observational and never
  touches signing (FEATURE_GUIDELINES rule 3). Proving wallet ownership is ADR 0004's deferred
  tier 3 and deserves its own security design, not a login mechanism bolted on here.

### 2. Password hashing: argon2id via the `argon2` npm package

Bindings to the reference C implementation, with prebuilt binaries for macOS/Linux/Windows, so no
compiler toolchain is needed. Parameters are OWASP's first recommended argon2id configuration
(m=19 MiB, t=2, p=1); they're stored inside each PHC hash string, and login transparently
re-hashes with the current parameters when an old hash is weaker, so raising cost later is a
one-line change with no migration. Chosen over bcrypt because argon2id is memory-hard (resists
GPU cracking better) and has no 72-byte silent truncation. Chosen over Node's built-in `scrypt`
because a dedicated, widely-audited password-hashing library with standard PHC output is the more
conventional, reviewable choice for a project that expects outside contributors to read this code.

Password policy is **length only** (10–256 characters), per NIST SP 800-63B — no composition
rules. The max bounds CPU spent on hashing.

### 3. Sessions: opaque random bearer tokens, stored hashed, server-side

- Token = `ots_` + 32 random bytes (base64url). Returned once, at signup/login.
- Only a **SHA-256 hash** of the token is persisted, so the accounts file can't be used to log in
  as anyone if it leaks. (SHA-256, not argon2, is correct here: the token has 256 bits of
  entropy, so there's nothing to brute-force.)
- **30-day absolute expiry**, not sliding. Logout deletes the session server-side immediately.
- **Roles are never baked into the token.** Every authenticated request re-reads the user's
  current record, so a promotion or demotion takes effect on the very next request.
- Sent as `Authorization: Bearer <token>`, not a cookie. The web UI and the APIs run on different
  local ports (cross-origin), and a bearer header isn't sent automatically by the browser, so
  there's no CSRF surface to defend. CORS is an explicit origin allowlist, never `*`.

Rejected: **JWTs.** Stateless tokens can't be revoked before expiry without adding a server-side
denylist — at which point it's a session store with extra steps and a signing secret to manage.

### 4. Persistence: a file-backed JSON store, same reasoning as `JsonFileLabelStore`

`JsonFileAccountStore`, behind an `AccountStore` interface. No database setup step for a
first-time contributor; swapping in Postgres/SQLite later is a same-interface change. Because this
file holds credentials, it's stricter than the label store: it re-reads on every call (so the
operator CLI and a running server never overwrite each other's changes), serializes writes
in-process, writes atomically (temp file + rename), creates the file `0600`, and prunes expired
sessions. It lives at `data/private/accounts.json` (git-ignored) unless `ACCOUNTS_STORE_PATH` says
otherwise.

Known limit: only one *process* should be writing at a time (the server, plus occasional CLI
calls). Multiple server instances behind a load balancer need a real database — see below.

### 5. Roles: `user` < `moderator` < `admin`

- **`user`** — every account at signup. There is no way to sign up as anything else.
- **`moderator`** — can mark a Community label Confirmed (Wave 2, ADR 0004).
- **`admin`** — everything a moderator can do, plus granting/revoking roles on other accounts.

Ordered, so `requireRole(token, "moderator")` passes for moderators and admins. `admin` exists
separately from `moderator` so "who can confirm labels" and "who can appoint the people who
confirm labels" are different powers — confirming a label shouldn't let someone hand out
confirmation rights.

### 6. How the first moderator/admin is granted (resolves ADR 0004's open question)

**The operator promotes an existing account from the command line:**

```sh
npm run set-role --workspace packages/features/accounts -- <email> admin
```

After that, admins grant/revoke `moderator` (and `admin`) over the API
(`PUT /accounts/users/:id/role`). No HTTP request can create the first admin, and there's a guard
against demoting the last remaining admin (it would make roles un-grantable without the CLI).

Why this and not the two obvious alternatives:

- **"First registered account becomes admin"** — on any fresh public deployment, whoever reaches
  the signup endpoint first (a scanner, a bot) gets admin. That's a race the operator can lose
  without ever knowing it happened.
- **An env var naming a bootstrap admin email** — this system doesn't verify email ownership (it
  never sends mail; see Deferred). So anyone who signs up with that email address first — before
  the operator does — becomes admin. Same takeover, slightly harder to hit.
- **The CLI** requires shell access to the machine holding the accounts file. Anyone with that
  already has total control of the deployment (they could edit the file directly), so the CLI
  grants no power that isn't already theirs — it just makes the legitimate path explicit, typed and
  audited by `roleUpdatedAt`.

On governance (*who* should be a moderator, as opposed to *how* it's granted): for now, moderators
are whoever the project operator appoints. A public, written moderator policy (criteria,
removal, conflicts of interest) is a community/governance decision for when there's a community,
not a code decision — deferred below.

### 7. Packaging: `packages/features/accounts/`, not `packages/core`

Accounts are a feature package (`@opentrace/accounts`) with a public API (`src/index.ts`) that
Wave 2 packages import. It's not in `core` because `core` is the chain-intelligence data model
(Address/Label/Tag/Entity) and has no runtime dependencies; accounts bring a native dependency
(argon2), file-system persistence and HTTP routes, none of which every chain adapter should carry.
The one thing the label model will need from accounts is a **user id** — an opaque string
(`UserId`, a random UUID) — so Wave 2 can add e.g. `confirmedBy: string` to `Label` in `core`
without `core` importing accounts at all. Ids, not emails, are what other records must store,
since an email is a mutable contact detail.

## What Wave 2 gets from this (and should not re-implement)

- `AccountService.authenticate(token)` → the current `PublicUser` or `unauthenticated` — the
  owner check for **private labels** (store labels keyed by `user.id`).
- `AccountService.requireRole(token, "moderator")` → the gate for **marking a label Confirmed**;
  record `user.id` as the confirmer.
- `createAccountsHandler(service)` returns `false` for non-`/accounts` paths, so it can be mounted
  inside another server (e.g. alongside the Explorer API) instead of running its own.
- `bearerToken(req)` to pull the token off any request.

## Deferred (explicitly not built)

- **Email verification and password reset by email** — needs outbound mail (an SMTP/provider
  credential). Until then an email is an identifier, not a verified contact, and a forgotten
  password can't be self-reset. The role-granting design above is deliberately safe *despite*
  unverified emails.
- **Login rate limiting / lockout** — argon2's cost slows online guessing but isn't a substitute.
  Needed before any public deployment; belongs with the deployment work (it's per-IP and
  proxy-aware, which depends on the hosting setup).
- **OAuth / "Sign in with GitHub"** — the most likely next login method once there's a hosting
  target.
- **Account deletion, email change, "log out everywhere," password change** — straightforward
  additions on the same store; none needed by Wave 2.
- **Self-attestation (wallet ownership proof)** — still ADR 0004's deferred tier 3.
- **A written moderator governance policy** — see section 6.
- **Account enumeration via signup** — signup returns 409 for an existing email, so it reveals
  whether an email has an account. Accepted for now (no email flow exists to do the usual
  "check your inbox" response); login itself doesn't leak it (same error and similar timing for
  unknown email vs wrong password).

## Consequences

- Wave 2 (Confirmed tier, private labels) is unblocked and should build on the functions above.
- Every running instance has a real credentials file to protect; it's git-ignored and `0600`, and
  only hashes (of passwords and of session tokens) are in it.
- One native dependency (`argon2`) enters the repo, with prebuilt binaries for the common
  platforms.

## What would change this decision

- **A real hosting target with more than one API instance** → replace `JsonFileAccountStore`
  with a database-backed `AccountStore` (same interface; no other code changes).
- **Outbound email becomes available** → add verification + reset; at that point an
  env-var-configured bootstrap admin email becomes a safe option too.
- **Real contributor demand for "Sign in with GitHub"** → add it as a second login method that
  issues the same opaque sessions; `StoredUser` would gain an optional linked-identity field and
  `passwordHash` would become optional. That's its own ADR.
