# @osstrace/accounts

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
over 16 KiB), plus `rate_limited` → 429 (below). A wrong password and an unknown email both
return the same `invalid_credentials`.

### Rate limits

Login and signup are rate limited in-process ([ADR 0015](../../../docs/adr/0015-accounts-login-and-signup-rate-limiting.md)
has the reasoning). Every window is a true sliding window, not a fixed one.

| Limit | Default |
|---|---|
| Failed logins for one email from one IP | 5 per 5 minutes. A successful login clears it. |
| Failed logins for one email from all IPs combined | 20 per 15 minutes |
| Failed logins from one IP across all emails | 30 per 5 minutes |
| Login requests from one IP, whatever the outcome | 60 per minute |
| Signup requests from one IP, whatever the outcome | 10 per hour |

Only *failed* logins count against the first three, so logging in correctly over and over is
never limited by them. The 60/minute cap is there so a flood of even-correct logins can't be used
to make the server hash passwords non-stop. Parallel attempts are counted before the password is
checked, so a burst of simultaneous guesses can't slip past the limit. A blocked request gets:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 250

{ "error": "rate_limited", "message": "too many attempts; try again in 250 seconds", "retryAfterSeconds": 250 }
```

`Retry-After` is the exact number of seconds until that caller would be allowed again (and it's
CORS-exposed, so the web UI can read it). A blocked login stays blocked even with the right
password. To change the limits, pass your own limiter:
`createAccountsHandler(service, { rateLimiter: new AccountsRateLimiter({ signupRequestsPerIp: { limit: 50, windowMs: 3_600_000 } }) })`.

Two caveats:

- **The caller's IP is the TCP peer address (`req.socket.remoteAddress`). `X-Forwarded-For` is
  not trusted**, because any client can set it. Behind a reverse proxy or load balancer every
  request looks like it comes from the proxy, so the per-IP limits apply to all users combined
  (the per-email ones still work). A proxied deployment needs an explicit trusted-proxy setting,
  which isn't built yet. IPv6 callers are grouped by /64.
- **Counters live in memory**, per process. A restart clears them, and several server instances
  would each count separately.

## Using it from another package (Wave 2)

Import from `@osstrace/accounts` only. Don't import its individual source files.

```ts
import { AccountService, JsonFileAccountStore, bearerToken } from "@osstrace/accounts";

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
  password can't be reset yet (an admin can't reset it either). This is waiting on a decision
  about an outbound email provider (it needs an SMTP/provider account and credential), so it's
  deliberately not built rather than faked.
- **No trusted-proxy setting for rate limiting.** See the caveat under Rate limits above.
- **No account deletion, email/password change, or "log out everywhere."**
- **One writer process at a time.** Running several server instances on one accounts file needs
  a database-backed `AccountStore`.
- **A minimal UI only.** The web UI has an email + password login/signup form and a logout
  button (`packages/web/src/AccountPanel.tsx`, shared by the private-labels and community-labels
  features). There are no account-management screens (role granting is API/CLI only).
- **No OAuth / "Sign in with GitHub."**
- **Signup reveals whether an email is registered** (409 `email_taken`), though probing it is
  capped by the signup rate limit. Login doesn't.

All of these are recorded with reasons in ADR 0006's "Deferred" section (and ADR 0015 for the
proxy caveat).

## Testing

`npm test` runs 52 tests against the real thing: real argon2 hashing, a real temp-file
`JsonFileAccountStore`, a real HTTP server on an ephemeral port called with `fetch`, and the
operator CLI run as a real child process. Nothing in the auth logic is mocked. The only test hook
is an injectable clock, used to prove that sessions expire, and rate-limit windows reopen, at
exactly the right instant through the real code path. The tests cover:
- the 6th failed login for an email gets 429 with an exact `Retry-After`, and the window reopens on time
- successful logins never count as failures, and one clears that email's failures
- 12 simultaneous wrong-password logins give exactly 5 401s and 7 429s
- the 11th signup from one IP within an hour gets 429
- a limited email or IP doesn't affect other emails or other IPs (tested with real IPv4 and IPv6 peers)
- wrong passwords and unknown emails are rejected identically
- forged and logged-out tokens fail
- each role check enforces the hierarchy
- non-admins can't grant roles
- the last admin can't be removed
- concurrent signups for one email can't both succeed
- a role set by the CLI process is seen live by a running service
