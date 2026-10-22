import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import "./harness/env.ts"; // registers the import.meta.env injection hook serverSession.ts needs, before its first dynamic import below
import { startNewServer, type RunningNewServer } from "./harness/newServer.ts";

/**
 * serverSession.ts against a real, booted @osstrace/server instance (ADR 0022) — real Fastify,
 * real in-memory SQLite, real signup/login/me/logout, real CORS headers.
 *
 * What this file does NOT cover: a session surviving a fresh page load. That needs a real
 * browser's cookie jar — Node's own `fetch` (what env.ts gives these tests, see its own doc
 * comment) has no cookie store at all, so a Set-Cookie from one request is never resent on the
 * next one here, unlike a real browser. That round trip was verified instead by driving the real
 * UI in headless Chromium against this same server (sign up, reload-equivalent navigation, still
 * authenticated, a real address's real balances and transfers rendered) — see packages/web/README.md.
 */
type ServerSessionModule = typeof import("../src/serverSession.ts");

let server: RunningNewServer;
let loads = 0;

async function freshServerSession(url: string): Promise<ServerSessionModule> {
  const previous = process.env["VITE_SERVER_URL"];
  process.env["VITE_SERVER_URL"] = url;
  try {
    return (await import(`../src/serverSession.ts?case=${++loads}`)) as ServerSessionModule;
  } finally {
    process.env["VITE_SERVER_URL"] = previous;
  }
}

before(async () => {
  server = await startNewServer(["http://localhost:5301"]);
});
after(async () => {
  await server.close();
});

afterEach(() => {
  delete process.env["VITE_SERVER_URL"];
});

test("with no session, the real server's own /api/auth/me refuses with 401 (no cookie sent)", async () => {
  const mod = await freshServerSession(server.url);
  const result = await mod.serverApiCall<{ user: unknown }>("/api/auth/me");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 401);
});

test("signup against a server with no origin allowance is refused by the real CSRF/CORS check — must send an allowed Origin", async () => {
  const mod = await freshServerSession(server.url);
  // serverApiCall itself doesn't set an Origin header (that's the browser's job); confirm the
  // real server's behaviour this app depends on: no Origin on a mutating request is refused.
  const message = await mod.serverSignIn("signup", `nosendoriginuser${Date.now()}`, "correct horse battery staple 9");
  assert.match(message ?? "", /origin/i);
});

test("a real signup against an origin the server allows succeeds and returns the real user", async () => {
  // This server instance allows http://localhost:5301 (set in before()); emulate the browser
  // sending that Origin on the mutating request the way a real page served from there would.
  const username = `signupok${Date.now()}`;
  const res = await fetch(`${server.url}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5301" },
    body: JSON.stringify({ username, password: "correct horse battery staple 9" }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { user: { username: string } };
  assert.equal(body.user.username, username);
  assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:5301");
  assert.equal(res.headers.get("access-control-allow-credentials"), "true");
});

test("a conflicting signup (username already taken) surfaces the real server message", async () => {
  const username = `dupeuser${Date.now()}`;
  const mk = () =>
    fetch(`${server.url}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5301" },
      body: JSON.stringify({ username, password: "correct horse battery staple 9" }),
    });
  const first = await mk();
  assert.equal(first.status, 201);
  const second = await mk();
  assert.equal(second.status, 409);
  const body = (await second.json()) as { error: { message: string } };
  assert.match(body.error.message, /taken/i);
});

test("login with the wrong password is refused with the real 401 message, same wording as an unknown username (no user-enumeration signal)", async () => {
  const username = `wrongpw${Date.now()}`;
  await fetch(`${server.url}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5301" },
    body: JSON.stringify({ username, password: "correct horse battery staple 9" }),
  });
  const wrongPw = await fetch(`${server.url}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5301" },
    body: JSON.stringify({ username, password: "totally the wrong password here" }),
  });
  const unknownUser = await fetch(`${server.url}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5301" },
    body: JSON.stringify({ username: `nosuchuser${Date.now()}`, password: "whatever password here" }),
  });
  assert.equal(wrongPw.status, 401);
  assert.equal(unknownUser.status, 401);
  const a = (await wrongPw.json()) as { error: { message: string } };
  const b = (await unknownUser.json()) as { error: { message: string } };
  assert.equal(a.error.message, b.error.message);
});

test("serverApiCall reports status 0 with a readable message when the server is genuinely unreachable", async () => {
  const mod = await freshServerSession("http://127.0.0.1:1"); // nothing listens on port 1
  const result = await mod.serverApiCall("/api/auth/me");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 0);
    assert.match(result.message, /127\.0\.0\.1:1/);
  }
});
