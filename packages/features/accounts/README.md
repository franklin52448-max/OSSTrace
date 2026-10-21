# @opentrace/accounts

Real user accounts: email + password signup/login, server-side sessions, and roles
(`user` < `moderator` < `admin`). It's the prerequisite for ADR 0004's Confirmed label tier and
private labels. It doesn't build either of those. It's the foundation they'll both call into.
The design and its tradeoffs are in [ADR 0006](../../../docs/adr/0006-accounts-and-auth.md).

## Running it

```sh
npm run dev --workspace packages/features/accounts
```

Listens on `ACCOUNTS_PORT` (default 5310). Accounts are stored in `data/private/accounts.json`
(git-ignored, created `0600` on first signup), or wherever `ACCOUNTS_STORE_PATH` points (relative
paths resolve from the repo root). Browser access is allowed only from the origins in
`ACCOUNTS_ALLOWED_ORIGINS` (comma-separated, default `http://localhost:5301`, the web UI). There's
no database and no setup step.

### Making the first admin

No HTTP request can create an admin. Sign up normally, then on the machine that holds the
accounts file run:

```sh
npm run set-role --workspace packages/features/accounts -- you@example.com admin
```

A running server picks this up on the next request, so there's no restart. After that, admins
grant `moderator`/`admin` to others over the API. The last remaining admin can't be demoted.
ADR 0006 explains why it works this way instead of "first signup is admin" or an env var.

## API

JSON in, JSON out. Errors are `{ "error": "<code>", "message": "..." }`. Authenticated routes take
`Authorization: Bearer <token>`. Every response is `Cache-Control: no-store`.

| Route | Auth | Body | Success |
|---|---|---|---|
| `POST /accounts/signup` | none | `{ email, password }` | `201 { user, session }` |
| `POST /accounts/login` | none | `{ email, password }` | `200 { user, session }` |
| `POST /accounts/logout` | bearer | none | `204` (revokes that session only) |
| `GET /accounts/me` | bearer | none | `200 { user }` |
| `GET /accounts/users` | bearer, admin | none | `200 { users }` |
| `PUT /accounts/users/:id/role` | bearer, admin | `{ role }` | `200 { user }` |

```sh
curl -X POST localhost:5310/accounts/signup -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a long passphrase"}'
```

```json
{
  "user": { "id": "08cf467f-…", "email": "you@example.com", "role": "user",
            "createdAt": "2026-10-21T21:00:13.158Z", "roleUpdatedAt": "2026-10-21T21:00:13.158Z" },
  "session": { "token": "ots_5uMG…", "expiresAt": "2026-11-20T21:00:13.191Z" }
}
```

Error codes and statuses: `invalid_email` / `invalid_password` / `invalid_role` → 400,
`invalid_credentials` / `unauthenticated` → 401, `forbidden` → 403, `not_found` → 404,
`email_taken` / `last_admin` → 409, plus `bad_request` (400 for malformed JSON, 413 for a body
over 16 KiB). A wrong password and an unknown email both return the same
`invalid_credentials`.

## Using it from another package (Wave 2)

Import from `@opentrace/accounts` only. Don't import its individual source files.

```ts
import { AccountService, JsonFileAccountStore, bearerToken } from "@opentrace/accounts";

const accounts = new AccountService(new JsonFileAccountStore(path));

// Private labels: who owns this request?
const me = await accounts.authenticate(bearerToken(req));
if (!me.ok) return 401;            // me.error === "unauthenticated"
// ...key the private label by me.user.id (never by email)

// Confirmed tier: is this person allowed to confirm?
const mod = await accounts.requireRole(bearerToken(req), "moderator");
if (!mod.ok) return mod.error === "forbidden" ? 403 : 401;
// ...record mod.user.id as the confirmer
```

Every service method returns `{ ok: true, ... } | { ok: false, error, message }`. Expected
failures (bad password, expired session, missing role) never throw.
`createAccountsHandler(service)` returns `false` for paths outside `/accounts`, so the routes can
be mounted inside another server instead of running this one.

## How it works

- **Passwords**: argon2id (`argon2` npm package, prebuilt binaries, no compiler needed;
  m=19 MiB, t=2, p=1). Length-only policy, 10–256 characters. Weaker legacy hashes are
  re-hashed on successful login.
- **Sessions**: `ots_` + 32 random bytes. Only the token's SHA-256 is stored. Expiry is a fixed
  30 days from login, and logout deletes the session server-side. The role isn't stored in the
  token. It's read fresh on every request, so a demotion applies on the very next call.
- **Store**: `JsonFileAccountStore` re-reads the file on every call, serializes writes, and
  writes atomically. See its docstring in `src/store.ts`.

## What's not built here yet

- **No email verification and no password reset.** This package never sends email, so an email
  address is an identifier and isn't proven to belong to the person using it. A forgotten
  password can't be reset yet (an admin can't reset it either).
- **No login rate limiting.** Add it before any public deployment.
- **No account deletion, email/password change, or "log out everywhere."**
- **One writer process at a time.** Running several server instances on one accounts file needs
  a database-backed `AccountStore`.
- **A minimal UI only.** The web UI has an email + password login/signup form and a logout
  button (`packages/web/src/AccountPanel.tsx`, shared by the private-labels and community-labels
  features). There are no account-management screens (role granting is API/CLI only).
- **No OAuth / "Sign in with GitHub."**
- **Signup reveals whether an email is registered** (409 `email_taken`). Login doesn't.

All of these are recorded with reasons in ADR 0006's "Deferred" section.

## Testing

`npm test` runs 37 tests against the real thing: real argon2 hashing, a real temp-file
`JsonFileAccountStore`, a real HTTP server on an ephemeral port called with `fetch`, and the
operator CLI run as a real child process. Nothing in the auth logic is mocked. The only test hook
is an injectable clock, used to prove that sessions expire at exactly the right instant through
the real code path. The tests cover:
- wrong passwords and unknown emails are rejected identically
- forged and logged-out tokens fail
- each role check enforces the hierarchy
- non-admins can't grant roles
- the last admin can't be removed
- concurrent signups for one email can't both succeed
- a role set by the CLI process is seen live by a running service
