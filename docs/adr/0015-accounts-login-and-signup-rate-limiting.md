# ADR 0015 — Accounts: in-process sliding-window rate limits on login and signup

Status: Decided 2026-10-22 (implemented in `packages/features/accounts/src/rate-limit.ts`, wired in `src/http.ts`)

## Context

ADR 0006 shipped email + password accounts and listed **login rate limiting / lockout** under
"Deferred": argon2id makes each guess cost ~19 MiB and tens of milliseconds, but nothing stopped a
caller from making as many guesses as it liked, or from creating accounts in a loop. That has to
be fixed before any public deployment.

There is no rate-limit utility anywhere in this repo, and there's still no hosting target (so no
reverse proxy, no Redis, no shared store to lean on). The Accounts API runs as one process.

## Decision

### 1. An exact sliding-window counter, in memory, inside the accounts package

`SlidingWindowLimiter` keeps, per key, the timestamps of counted events inside the window (a
"sliding log"). A key is blocked once it holds `limit` timestamps newer than `now - window`, and
unblocks the instant the oldest one ages out, which is exactly the `Retry-After` it reports. Blocked
events are never recorded, so one key never holds more than `limit` timestamps however hard it's
hammered. Across keys, aged-out keys are swept every 1000 writes and live keys are capped at
50,000 per limiter (least recently written dropped first, which fails *open* for that key rather than
closed for everyone).

Chosen over fixed windows (which let a caller do 2x the limit across a window boundary) and over
token buckets (fine, but "5 failures in 5 minutes" is the rule people expect to read, and an exact
log makes `Retry-After` exact). It lives in `@osstrace/accounts`, not `@osstrace/core`: this is the
first and only consumer, and `core`'s `InMemoryCache` popularity counter is a different thing
(ranking, not blocking). Extract a shared one when a second consumer needs the exact same shape.

### 2. The limits

| Rule | Key | Counts | Default | Reset by a successful login? |
|---|---|---|---|---|
| `loginFailuresPerEmailAndIp` | normalized email + IP | failed logins | **5 per 5 min** | yes, cleared |
| `loginFailuresPerEmail` | normalized email | failed logins, all IPs | **20 per 15 min** | no (only that attempt's own slot is handed back) |
| `loginFailuresPerIp` | IP | failed logins, all emails | **30 per 5 min** | no (only that attempt's own slot is handed back) |
| `loginRequestsPerIp` | IP | every login request, any outcome | **60 per 1 min** | n/a |
| `signupRequestsPerIp` | IP | every signup request, any outcome | **10 per hour** | n/a |

Why these shapes:

- **Only failures count against the login limiters.** A real user who logs in from many tabs or
  devices all day never hits them. A failure is any non-ok result from `AccountService.login` (wrong
  password, unknown email, malformed fields); the service already returns the same
  `invalid_credentials` for all of those, so there's nothing to distinguish.
- **5 per (email, IP) per 5 minutes** is the main brute-force brake: a typo-prone user gets five
  tries, an attacker gets one guess a minute. A successful login wipes it, so "fumbled 4 times, got
  it, mistyped again later" isn't punished.
- **20 per email across all IPs per 15 minutes** stops a distributed guess at one account (many IPs,
  each under 5). It's the one rule that lets an attacker who knows your email lock *you* out, for up
  to 15 minutes at a time and only while they keep failing. Accepted: it's temporary, it's the
  standard tradeoff (OWASP's account-lockout guidance), and without it the per-pair rule means
  nothing against a botnet. A success doesn't wipe it, because a success from one place says nothing
  about guesses from elsewhere.
- **30 per IP across all emails per 5 minutes** stops one IP spraying a common password across
  many accounts, which the per-email rules can't see. A success doesn't wipe it either: otherwise an
  attacker could log into their own account between guesses to reset their count.
- **60 login requests per IP per minute, regardless of outcome.** The failure limiters can't stop a
  flood of *correct*-password logins, and each login is still an argon2 verify. This cap is checked
  before the body is even read, so it bounds the hashing work one IP can force on us. It's loose
  enough that no person hits it.
- **Signup: 10 per IP per hour, every attempt counted.** Each signup is a different email by
  definition, so per-email tracking is pointless; per-IP stops a script creating hundreds of
  accounts. Failed signups count too: each is still an argon2 hash, and a 409 `email_taken` is the
  enumeration oracle ADR 0006 accepted, so probing it should cost something.

All five are fields of `AccountsRateLimits` and can be overridden by constructing an
`AccountsRateLimiter` and passing it as `createAccountsHandler(service, { rateLimiter })`.

### 3. Parallel attempts are counted before the password check, not after

A login attempt that passes the check *reserves* a failure slot in all three failure limiters before
calling the service, and gives it back (or, for the pair key, clears it) if the password is right.
Counting only after argon2 returns would let a burst of parallel requests all pass the check while
the first is still hashing, so "5 failures" would really mean "however many fit in one argon2
round-trip". A test fires 12 wrong-password logins at once and gets exactly 5 401s and 7 429s.

### 4. Blocked → `429 Too Many Requests` with `Retry-After`

Body: `{ "error": "rate_limited", "message": "too many attempts; try again in N seconds", "retryAfterSeconds": N }`,
header `Retry-After: N` (whole seconds, rounded up, at least 1), where N is when the tripped rule
would next allow a request (the longest wait if several tripped). `Retry-After` is added to CORS
`Access-Control-Expose-Headers` so the web UI can read it. A blocked login is blocked even with the
right password; that's the point of a limit.

### 5. Caller identity is the TCP peer address, and forwarded headers are NOT trusted

The IP is `req.socket.remoteAddress`. No package in this repo reads `X-Forwarded-For` or similar
today, and this code doesn't start: those headers are set by the client unless a trusted proxy
overwrites them, so trusting one by default would let anyone pick a fresh "IP" per request and walk
straight past every per-IP rule. IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is unwrapped to the IPv4
address, and native IPv6 is keyed by its **/64 prefix**, because one host or customer is routinely
handed a whole /64 and could otherwise rotate through 2^64 addresses.

**Known limitation: behind a reverse proxy or load balancer, every request appears to come from the
proxy's address.** The per-IP limits then apply to all users combined (signup would allow 10 per hour
for the whole site), while the per-email limits still work. A deployment behind a proxy needs a
deliberate, explicit "trust `X-Forwarded-For` from these proxy addresses" setting, taking the
right-most untrusted hop. That's part of the deployment work, decided together with the hosting
target, not guessed at here.

### 6. State is per process and lost on restart

Same as every other in-memory structure in this repo. A restart gives every caller a clean slate,
which is acceptable for a single-process deployment (an attacker can't trigger restarts). Several
API instances would each count separately, so effective limits multiply by the instance count; that
deployment needs the same shared store (e.g. Redis) the `AccountStore` would need anyway (ADR 0006).

## Not decided here

- **Email verification and password reset** remain deferred (ADR 0006): they need an outbound email
  provider and credential, which is the project owner's cost/vendor decision.
- **CAPTCHA or proof-of-work after N failures** — not needed while the limits above hold; revisit if
  real abuse shows up.
- **Persisted lockout state / alerting on lockouts** — nothing to alert to yet.

## What would change this decision

- **A hosting target with a reverse proxy** → add an explicit trusted-proxy setting (section 5).
- **More than one API instance** → move the counters to the shared store the accounts data moves to.
- **A second package needing the same limiter** → extract `SlidingWindowLimiter` into a shared package.
- **Real users hitting a limit legitimately** (e.g. a classroom signing up from one NAT address) →
  raise that one default; they're all single numbers in `DEFAULT_ACCOUNTS_RATE_LIMITS`.
