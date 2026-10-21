import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAccountsHandler } from "../src/http.ts";
import { AccountService } from "../src/service.ts";
import { JsonFileAccountStore } from "../src/store.ts";
import { GOOD_PASSWORD, withTempAccountsFile } from "./helpers.ts";

const WEB_ORIGIN = "http://localhost:5301";

/** A real HTTP server on an ephemeral port, real service, real temp-file store. */
async function withServer(run: (base: string, service: AccountService) => Promise<void>): Promise<void> {
  await withTempAccountsFile(async (path) => {
    const service = new AccountService(new JsonFileAccountStore(path));
    const handle = createAccountsHandler(service, { allowedOrigins: [WEB_ORIGIN] });
    const server: Server = createServer(async (req, res) => {
      if (!(await handle(req, res))) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${port}`, service);
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
