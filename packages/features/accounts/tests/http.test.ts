import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAccountsHandler } from "../src/http.ts";
import { AccountsRateLimiter } from "../src/rate-limit.ts";
import { AccountService } from "../src/service.ts";
import { JsonFileAccountStore } from "../src/store.ts";
import { GOOD_PASSWORD, TestClock, withTempAccountsFile } from "./helpers.ts";

const WEB_ORIGIN = "http://localhost:5301";

/** A real HTTP server on an ephemeral port, real service, real temp-file store. */
async function withServer(
  run: (base: string, service: AccountService, port: number) => Promise<void>,
  options: { rateLimiter?: AccountsRateLimiter; host?: string } = {},
): Promise<void> {
  await withTempAccountsFile(async (path) => {
    const service = new AccountService(new JsonFileAccountStore(path));
    const handle = createAccountsHandler(service, { allowedOrigins: [WEB_ORIGIN], rateLimiter: options.rateLimiter });
    const server: Server = createServer(async (req, res) => {
      if (!(await handle(req, res))) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, options.host ?? "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${port}`, service, port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

async function call(
  base: string,
  method: string,
  path: string,
  options: { body?: unknown; rawBody?: string; token?: string; origin?: string } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined || options.rawBody !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers["authorization"] = `Bearer ${options.token}`;
  if (options.origin) headers["origin"] = options.origin;
  const res = await fetch(base + path, {
    method,
    headers,
    body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

test("full flow over real HTTP: signup → me → logout → me rejected → login → me", async () => {
  await withServer(async (base) => {
    const signup = await call(base, "POST", "/accounts/signup", { body: { email: "a@example.com", password: GOOD_PASSWORD } });
    assert.equal(signup.status, 201);
    assert.equal(signup.body.user.role, "user");
    assert.equal(signup.body.user.passwordHash, undefined);
    assert.equal(signup.headers.get("cache-control"), "no-store");
    const token = signup.body.session.token as string;

    const me = await call(base, "GET", "/accounts/me", { token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, "a@example.com");

    assert.equal((await call(base, "POST", "/accounts/logout", { token })).status, 204);
    const after = await call(base, "GET", "/accounts/me", { token });
    assert.equal(after.status, 401);
    assert.equal(after.body.error, "unauthenticated");

    const login = await call(base, "POST", "/accounts/login", { body: { email: "a@example.com", password: GOOD_PASSWORD } });
    assert.equal(login.status, 200);
    assert.equal((await call(base, "GET", "/accounts/me", { token: login.body.session.token })).status, 200);
  });
});

test("HTTP status codes: 400 bad input, 409 duplicate, 401 wrong password, 401 no token", async () => {
  await withServer(async (base) => {
    assert.equal((await call(base, "POST", "/accounts/signup", { body: { email: "x", password: GOOD_PASSWORD } })).status, 400);
    assert.equal((await call(base, "POST", "/accounts/signup", { body: { email: "a@example.com", password: "short" } })).status, 400);
    assert.equal((await call(base, "POST", "/accounts/signup", { body: { email: "a@example.com", password: GOOD_PASSWORD } })).status, 201);
    assert.equal((await call(base, "POST", "/accounts/signup", { body: { email: "a@example.com", password: GOOD_PASSWORD } })).status, 409);

    const wrong = await call(base, "POST", "/accounts/login", { body: { email: "a@example.com", password: "wrong password!!" } });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error, "invalid_credentials");
    assert.equal(wrong.body.session, undefined);

    assert.equal((await call(base, "GET", "/accounts/me")).status, 401);
    assert.equal((await call(base, "POST", "/accounts/logout")).status, 401);
  });
});

test("malformed and oversized bodies are rejected without reaching the service", async () => {
  await withServer(async (base) => {
    const bad = await call(base, "POST", "/accounts/login", { rawBody: "{ not json" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "bad_request");
    assert.equal((await call(base, "POST", "/accounts/login", { rawBody: "[1,2]" })).status, 400);
    const huge = await call(base, "POST", "/accounts/signup", { body: { email: "a@example.com", password: "x".repeat(20_000) } });
    assert.equal(huge.status, 413);
  });
});

test("role endpoints over HTTP: user gets 403, admin can list users and grant moderator", async () => {
  await withServer(async (base, service) => {
    const user = await call(base, "POST", "/accounts/signup", { body: { email: "user@example.com", password: GOOD_PASSWORD } });
    const admin = await call(base, "POST", "/accounts/signup", { body: { email: "admin@example.com", password: GOOD_PASSWORD } });
    // The first admin can't be created over HTTP at all — only via the operator path.
    assert.ok((await service.setRoleAsOperator("admin@example.com", "admin")).ok);

    const userId = user.body.user.id as string;
    const forbidden = await call(base, "PUT", `/accounts/users/${userId}/role`, { token: user.body.session.token, body: { role: "admin" } });
    assert.equal(forbidden.status, 403);
    assert.equal((await call(base, "GET", "/accounts/users", { token: user.body.session.token })).status, 403);

    const list = await call(base, "GET", "/accounts/users", { token: admin.body.session.token });
    assert.equal(list.status, 200);
    assert.equal(list.body.users.length, 2);

    const granted = await call(base, "PUT", `/accounts/users/${userId}/role`, { token: admin.body.session.token, body: { role: "moderator" } });
    assert.equal(granted.status, 200);
    assert.equal(granted.body.user.role, "moderator");
    assert.equal((await call(base, "GET", "/accounts/me", { token: user.body.session.token })).body.user.role, "moderator");
  });
});

test("a malformed %-escape in a user id is a 400 bad request, not a 500 internal error", async () => {
  await withServer(async (base, service) => {
    const admin = await call(base, "POST", "/accounts/signup", { body: { email: "admin@example.com", password: GOOD_PASSWORD } });
    assert.ok((await service.setRoleAsOperator("admin@example.com", "admin")).ok);
    // Before: decodeURIComponent's URIError fell through to the catch-all → 500 "internal error".
    const res = await call(base, "PUT", "/accounts/users/%E0%A4%A/role", { token: admin.body.session.token, body: { role: "moderator" } });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "bad_request");
  });
});

test("CORS: only the configured origin is allowed, never '*'", async () => {
  await withServer(async (base) => {
    const allowed = await call(base, "OPTIONS", "/accounts/login", { origin: WEB_ORIGIN });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-origin"), WEB_ORIGIN);
    assert.match(allowed.headers.get("access-control-allow-headers") ?? "", /authorization/);

    const other = await call(base, "OPTIONS", "/accounts/login", { origin: "https://evil.example" });
    assert.equal(other.headers.get("access-control-allow-origin"), null);
  });
});

test("paths outside /accounts are left for the host server", async () => {
  await withServer(async (base) => {
    assert.equal((await call(base, "GET", "/address/ethereum/0xabc")).status, 404);
    assert.equal((await call(base, "GET", "/accounts/nope")).body.error, "not_found");
  });
});

// ---- Rate limiting (ADR 0015). Real server, real argon2, real limiter; only the clock is injected. ----

const WRONG = "wrong password!!";

function limiterWithClock(clock: TestClock): AccountsRateLimiter {
  return new AccountsRateLimiter({}, () => clock.now().getTime());
}

function login(base: string, email: string, password: string) {
  return call(base, "POST", "/accounts/login", { body: { email, password } });
}

function signup(base: string, email: string, password = GOOD_PASSWORD) {
  return call(base, "POST", "/accounts/signup", { body: { email, password } });
}

test("the 6th failed login for one email within 5 minutes is a 429 with Retry-After, not a 401", async () => {
  const clock = new TestClock();
  await withServer(
    async (base) => {
      assert.equal((await signup(base, "a@example.com")).status, 201);
      for (let i = 1; i <= 5; i++) {
        clock.advance(10_000);
        assert.equal((await login(base, "a@example.com", WRONG)).status, 401, `attempt ${i}`);
      }
      clock.advance(10_000);
      const sixth = await login(base, "a@example.com", WRONG);
      assert.equal(sixth.status, 429);
      assert.equal(sixth.body.error, "rate_limited");
      // First failure was at +10s and it's now +60s: that failure leaves the 5-minute window at +310s.
      assert.equal(sixth.headers.get("retry-after"), "250");
      assert.equal(sixth.body.retryAfterSeconds, 250);

      // Blocked means blocked: even the right password gets no session while the limit holds,
      // and the key is the normalized email, so case/whitespace variants don't dodge it.
      const right = await login(base, "  A@Example.com ", GOOD_PASSWORD);
      assert.equal(right.status, 429);
      assert.equal(right.body.session, undefined);

      // Exactly when Retry-After says, the oldest failure ages out and an attempt is allowed again.
      clock.advance(249_000);
      assert.equal((await login(base, "a@example.com", GOOD_PASSWORD)).status, 429);
      clock.advance(1_000);
      assert.equal((await login(base, "a@example.com", GOOD_PASSWORD)).status, 200);
    },
    { rateLimiter: limiterWithClock(clock) },
  );
});

test("successful logins never count as failures, and one clears that email's failures from that IP", async () => {
  await withServer(async (base) => {
    assert.equal((await signup(base, "a@example.com")).status, 201);
    for (let i = 0; i < 12; i++) assert.equal((await login(base, "a@example.com", GOOD_PASSWORD)).status, 200);
    // 4 typos, then the right password: the slate is wiped, so 5 more typos are all plain 401s.
    for (let i = 0; i < 4; i++) assert.equal((await login(base, "a@example.com", WRONG)).status, 401);
    assert.equal((await login(base, "a@example.com", GOOD_PASSWORD)).status, 200);
    for (let i = 0; i < 5; i++) assert.equal((await login(base, "a@example.com", WRONG)).status, 401);
    assert.equal((await login(base, "a@example.com", WRONG)).status, 429);
  });
});

test("parallel wrong-password logins can't slip past the limit while argon2 is busy", async () => {
  await withServer(async (base) => {
    assert.equal((await signup(base, "a@example.com")).status, 201);
    const statuses = (await Promise.all(Array.from({ length: 12 }, () => login(base, "a@example.com", WRONG)))).map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 401).length, 5, statuses.join(","));
    assert.equal(statuses.filter((s) => s === 429).length, 7, statuses.join(","));
  });
});

test("many signups from one IP get 429 after the 10th within an hour", async () => {
  const clock = new TestClock();
  await withServer(
    async (base) => {
      for (let i = 1; i <= 10; i++) {
        clock.advance(60_000);
        assert.equal((await signup(base, `bot${i}@example.com`)).status, 201, `signup ${i}`);
      }
      const eleventh = await signup(base, "bot11@example.com");
      assert.equal(eleventh.status, 429);
      assert.equal(eleventh.body.error, "rate_limited");
      // First signup was at +1 min and it's now +10 min: it leaves the 1-hour window at +61 min.
      assert.equal(eleventh.headers.get("retry-after"), String(51 * 60));
      // Failed signups are blocked too (each one is still an argon2 hash or an email-taken probe).
      assert.equal((await signup(base, "x", "short")).status, 429);
      // Login is a separate limiter: the blocked IP can still sign in to an account it already has.
      assert.equal((await login(base, "bot1@example.com", GOOD_PASSWORD)).status, 200);
      clock.advance(51 * 60_000);
      assert.equal((await signup(base, "bot11@example.com")).status, 201);
    },
    { rateLimiter: limiterWithClock(clock) },
  );
});

test("the limiter doesn't block other emails or other IPs", async () => {
  // Listening on "::" lets one server see two genuinely different peers: 127.0.0.1 (which arrives
  // as ::ffff:127.0.0.1) and ::1.
  await withServer(
    async (_base, _service, port) => {
      const v4 = `http://127.0.0.1:${port}`;
      const v6 = `http://[::1]:${port}`;
      assert.equal((await signup(v4, "a@example.com")).status, 201);
      assert.equal((await signup(v4, "b@example.com")).status, 201);
      for (let i = 0; i < 5; i++) assert.equal((await login(v4, "a@example.com", WRONG)).status, 401);
      assert.equal((await login(v4, "a@example.com", WRONG)).status, 429);
      // Same IP, different email: unaffected.
      assert.equal((await login(v4, "b@example.com", WRONG)).status, 401);
      assert.equal((await login(v4, "b@example.com", GOOD_PASSWORD)).status, 200);
      // Different IP, same email: the per-(email, IP) limit doesn't follow the email elsewhere.
      assert.equal((await login(v6, "a@example.com", GOOD_PASSWORD)).status, 200);
    },
    { host: "::" },
  );
});

test("a flood of login requests from one IP is capped regardless of outcome", async () => {
  const clock = new TestClock();
  const limiter = new AccountsRateLimiter({ loginRequestsPerIp: { limit: 8, windowMs: 60_000 } }, () => clock.now().getTime());
  await withServer(
    async (base) => {
      assert.equal((await signup(base, "a@example.com")).status, 201);
      for (let i = 0; i < 8; i++) assert.equal((await login(base, "a@example.com", GOOD_PASSWORD)).status, 200);
      const capped = await login(base, "a@example.com", GOOD_PASSWORD);
      assert.equal(capped.status, 429);
      assert.equal(capped.headers.get("retry-after"), "60");
      // The cap is checked before the body is read, so even garbage counts against it.
      assert.equal((await call(base, "POST", "/accounts/login", { rawBody: "{ not json" })).status, 429);
      clock.advance(60_000);
      assert.equal((await login(base, "a@example.com", GOOD_PASSWORD)).status, 200);
    },
    { rateLimiter: limiter },
  );
});

test("CORS exposes Retry-After so the web UI can read it on a 429", async () => {
  await withServer(async (base) => {
    const res = await call(base, "OPTIONS", "/accounts/login", { origin: WEB_ORIGIN });
    assert.match(res.headers.get("access-control-expose-headers") ?? "", /retry-after/);
  });
});
