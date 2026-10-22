import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth/password.ts";
import { Client, makeApp, ORIGIN, signup, type TestApp } from "./helpers.ts";

describe("password hashing", () => {
  it("uses scrypt N=2^15 r=8 p=1 with a 16-byte salt and verifies in constant time", async () => {
    const h = await hashPassword("correct horse battery");
    const [alg, logN, r, p, salt, key] = h.split("$");
    expect([alg, logN, r, p]).toEqual(["scrypt", "15", "8", "1"]);
    expect(Buffer.from(salt!, "base64")).toHaveLength(16);
    expect(Buffer.from(key!, "base64")).toHaveLength(32);
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("correct horse batterY", h)).toBe(false);
    expect(await hashPassword("correct horse battery")).not.toBe(h); // random salt
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("auth API", () => {
  let t: TestApp;
  beforeEach(async () => (t = await makeApp()));
  afterEach(async () => t.close());

  it("signup -> me -> logout -> 401; cookie is httpOnly SameSite=Lax, token stored hashed", async () => {
    const c = new Client(t.app);
    const r = await c.post("/api/auth/signup", { username: "Alice_1", password: "correct horse battery", displayName: "Al" });
    expect(r.statusCode).toBe(201);
    expect(r.json().user).toMatchObject({ username: "alice_1", displayName: "Al" });
    const cookie = r.cookies.find((x) => x.name === "osstrace_session")!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Lax");
    expect(cookie.maxAge).toBe(30 * 86400);
    const stored = t.ctx.db.get<{ token_hash: string }>("SELECT token_hash FROM sessions")!;
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.token_hash).not.toContain(cookie.value);
    expect((await c.get("/api/auth/me")).json().user.username).toBe("alice_1");
    expect((await c.post("/api/auth/logout")).statusCode).toBe(204);
    expect((await c.get("/api/auth/me")).statusCode).toBe(401);
    expect(t.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions")!.n).toBe(0);
  });

  it("validates usernames/passwords and refuses duplicates case-insensitively", async () => {
    const c = new Client(t.app);
    expect((await c.post("/api/auth/signup", { username: "ab", password: "correct horse battery" })).statusCode).toBe(400);
    expect((await c.post("/api/auth/signup", { username: "bad name", password: "correct horse battery" })).statusCode).toBe(400);
    expect((await c.post("/api/auth/signup", { username: "bob", password: "short" })).json().error.code).toBe("bad_request");
    const h = (await c.get("/api/health")).json();
    expect(h.allowSignup).toBe(true);
    expect((await c.post("/api/auth/signup", { username: "bob", password: "correct horse battery" })).statusCode).toBe(201);
    const dup = await new Client(t.app).post("/api/auth/signup", { username: "BOB", password: "correct horse battery" });
    expect(dup.statusCode).toBe(409);
  });

  it("login: wrong password and unknown user give the same answer; throttles after 5 failures per (ip, username)", async () => {
    await signup(t.app, "carol");
    const c = new Client(t.app);
    const bad = await c.post("/api/auth/login", { username: "carol", password: "wrong password!" });
    const unknown = await c.post("/api/auth/login", { username: "nobody", password: "wrong password!" });
    expect(bad.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(bad.json()).toEqual(unknown.json());
    for (let i = 0; i < 4; i++) expect((await c.post("/api/auth/login", { username: "carol", password: "nope nope nope" })).statusCode).toBe(401);
    const locked = await c.post("/api/auth/login", { username: "carol", password: "correct horse battery" });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe("rate_limited");
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
    // A different ip is not affected by this (ip, username) lock.
    const other = await t.app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "10.9.9.9",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      payload: JSON.stringify({ username: "carol", password: "correct horse battery" }),
    });
    expect(other.statusCode).toBe(200);
  });

  it("expired sessions are rejected; stale sessions slide and re-send the cookie", async () => {
    const c = await signup(t.app, "dave");
    t.ctx.db.run("UPDATE sessions SET last_seen_at = '2020-01-01T00:00:00.000000Z'");
    const slid = await c.get("/api/auth/me");
    expect(slid.statusCode).toBe(200);
    expect(slid.cookies.find((x) => x.name === "osstrace_session")?.maxAge).toBe(30 * 86400);
    const exp = t.ctx.db.get<{ expires_at: string }>("SELECT expires_at FROM sessions")!;
    expect(Date.parse(exp.expires_at)).toBeGreaterThan(Date.now() + 29 * 86400_000);
    t.ctx.db.run("UPDATE sessions SET expires_at = '2020-01-01T00:00:00.000Z'");
    expect((await c.get("/api/auth/me")).statusCode).toBe(401);
  });

  it("CSRF: mutating requests need an allowed Origin (or Referer) and a JSON content type", async () => {
    const noOrigin = await t.app.inject({ method: "POST", url: "/api/auth/signup", headers: { "content-type": "application/json" }, payload: '{"username":"eve","password":"correct horse battery"}' });
    expect(noOrigin.statusCode).toBe(403);
    const evil = await t.app.inject({ method: "POST", url: "/api/auth/signup", headers: { origin: "https://evil.example", "content-type": "application/json" }, payload: "{}" });
    expect(evil.statusCode).toBe(403);
    const form = await t.app.inject({ method: "POST", url: "/api/auth/signup", headers: { origin: ORIGIN, "content-type": "text/plain" }, payload: '{"username":"eve","password":"correct horse battery"}' });
    expect(form.statusCode).toBe(415);
    const referer = await t.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      headers: { referer: `${ORIGIN}/signup`, "content-type": "application/json" },
      payload: '{"username":"eve","password":"correct horse battery"}',
    });
    expect(referer.statusCode).toBe(201);
    const sameOrigin = await t.app.inject({ method: "POST", url: "/api/auth/logout", headers: { origin: "http://localhost:80", host: "localhost:80" } });
    expect(sameOrigin.statusCode).toBe(204);
    // GETs are not origin-checked; errors never leak stack traces
    const nf = await t.app.inject({ method: "GET", url: "/api/nope" });
    expect(nf.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
    const bad = await t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: ORIGIN, "content-type": "application/json" }, payload: "{not json" });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toMatch(/at .*\.ts/);
  });

  it("security headers are set", async () => {
    const r = await t.app.inject({ method: "GET", url: "/api/auth/me" });
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(String(r.headers["content-security-policy"])).toContain("default-src 'none'");
  });

  it("signup can be disabled", async () => {
    const t2 = await makeApp({ allowSignup: false });
    const r = await new Client(t2.app).post("/api/auth/signup", { username: "frank", password: "correct horse battery" });
    expect(r.statusCode).toBe(403);
    expect((await new Client(t2.app).get("/api/health")).json().allowSignup).toBe(false);
    await t2.close();
  });

  it("change password revokes other sessions; sessions can be listed and revoked", async () => {
    const a = await signup(t.app, "gina");
    const b = new Client(t.app);
    expect((await b.post("/api/auth/login", { username: "gina", password: "correct horse battery" })).statusCode).toBe(200);
    const list = (await a.get("/api/auth/sessions")).json() as { id: string; current: boolean }[];
    expect(list).toHaveLength(2);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    const wrong = await a.post("/api/auth/change-password", { currentPassword: "wrong wrong wrong", newPassword: "another long password" });
    expect(wrong.statusCode).toBe(400); // never 401: the session is valid, the field is wrong
    expect(wrong.json().error.code).toBe("bad_request");
    expect((await a.post("/api/auth/change-password", { currentPassword: "correct horse battery", newPassword: "another long password" })).statusCode).toBe(204);
    expect((await a.get("/api/auth/me")).statusCode).toBe(200);
    expect((await b.get("/api/auth/me")).statusCode).toBe(401);
    const c = new Client(t.app);
    expect((await c.post("/api/auth/login", { username: "gina", password: "another long password" })).statusCode).toBe(200);
    const cs = ((await a.get("/api/auth/sessions")).json() as { id: string; current: boolean }[]).find((s) => !s.current)!;
    expect((await a.del(`/api/auth/sessions/${cs.id}`)).statusCode).toBe(204);
    expect((await c.get("/api/auth/me")).statusCode).toBe(401);
    // another user's session id is a 404
    const other = await signup(t.app, "hank");
    expect((await other.del(`/api/auth/sessions/${list[0]!.id}`)).statusCode).toBe(404);
  });

  it("delete account requires the password and cascades every user-owned row", async () => {
    const a = await signup(t.app, "ivan");
    await a.post("/api/labels", { chain: "ethereum", address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", name: "x" });
    await a.post("/api/traces", { initialAddress: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" });
    await a.post("/api/tags", { name: "t" });
    const wrong = await a.del("/api/auth/account", { password: "nope nope nope" });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe("bad_request");
    expect((await a.del("/api/auth/account", { password: "correct horse battery" })).statusCode).toBe(204);
    for (const table of ["users", "sessions", "labels", "traces", "trace_nodes", "tags", "notification_methods"]) {
      expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n, table).toBe(0);
    }
  });
});
