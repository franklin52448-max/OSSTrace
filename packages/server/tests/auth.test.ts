import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { Wallet } from "ethers";
import { Client, makeApp, ORIGIN, signup, testWallet, type TestApp } from "./helpers.ts";

async function solanaLogin(c: Client, seed: string) {
  const { address, secretKey } = testWallet(seed);
  const chal = await c.post("/api/auth/challenge", { chain: "solana", address });
  const { message } = chal.json() as { message: string };
  const signature = Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), secretKey)).toString("base64");
  return { res: await c.post("/api/auth/verify", { chain: "solana", address, signature }), address };
}

async function ethereumLogin(c: Client, wallet: Wallet) {
  const address = wallet.address;
  const chal = await c.post("/api/auth/challenge", { chain: "ethereum", address });
  const { message } = chal.json() as { message: string };
  const signature = await wallet.signMessage(message);
  return { res: await c.post("/api/auth/verify", { chain: "ethereum", address, signature }), address };
}

describe("wallet auth API", () => {
  let t: TestApp;
  beforeEach(async () => (t = await makeApp()));
  afterEach(async () => t.close());

  it("solana: challenge -> verify -> me -> logout -> 401; cookie is httpOnly SameSite=Lax, token stored hashed", async () => {
    const c = new Client(t.app);
    const { res, address } = await solanaLogin(c, "alice");
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ chain: "solana", walletAddress: address });
    const cookie = res.cookies.find((x) => x.name === "osstrace_session")!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Lax");
    expect(cookie.maxAge).toBe(30 * 86400);
    const stored = t.ctx.db.get<{ token_hash: string }>("SELECT token_hash FROM sessions")!;
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.token_hash).not.toContain(cookie.value);
    expect((await c.get("/api/auth/me")).json().user.walletAddress).toBe(address);
    expect((await c.post("/api/auth/logout")).statusCode).toBe(204);
    expect((await c.get("/api/auth/me")).statusCode).toBe(401);
    expect(t.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions")!.n).toBe(0);
  });

  it("ethereum: challenge -> verify with a real secp256k1 signature logs in", async () => {
    const wallet = new Wallet("0x" + createHash("sha256").update("eth-bob").digest("hex"));
    const c = new Client(t.app);
    const { res, address } = await ethereumLogin(c, wallet);
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ chain: "ethereum", walletAddress: address.toLowerCase() });
    expect((await c.get("/api/auth/me")).json().user.walletAddress).toBe(address.toLowerCase());
  });

  it("signing in again with the same wallet returns the same user, not a new one", async () => {
    const c1 = new Client(t.app);
    const first = (await solanaLogin(c1, "carol")).res.json().user;
    const c2 = new Client(t.app);
    const second = (await solanaLogin(c2, "carol")).res.json().user;
    expect(second.id).toBe(first.id);
    expect(t.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users")!.n).toBe(1);
  });

  it("rejects a wrong signature, a missing challenge, and a replayed (already-consumed) one", async () => {
    const c = new Client(t.app);
    const { address, secretKey } = testWallet("dave");
    const other = testWallet("eve");

    // No challenge was ever requested for this address.
    const noChallenge = await c.post("/api/auth/verify", { chain: "solana", address, signature: Buffer.from(new Uint8Array(64)).toString("base64") });
    expect(noChallenge.statusCode).toBe(401);

    const chal = await c.post("/api/auth/challenge", { chain: "solana", address });
    const { message } = chal.json() as { message: string };

    // Signed with the WRONG key for this address.
    const wrongSig = Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), other.secretKey)).toString("base64");
    expect((await c.post("/api/auth/verify", { chain: "solana", address, signature: wrongSig })).statusCode).toBe(401);

    // Correct signature: the earlier attempt already consumed the nonce, so a fresh challenge is needed.
    const chal2 = await c.post("/api/auth/challenge", { chain: "solana", address });
    const { message: message2 } = chal2.json() as { message: string };
    const sig = Buffer.from(nacl.sign.detached(new TextEncoder().encode(message2), secretKey)).toString("base64");
    const ok = await c.post("/api/auth/verify", { chain: "solana", address, signature: sig });
    expect(ok.statusCode).toBe(200);

    // Replaying the same (now-consumed) challenge/signature fails.
    const replay = await c.post("/api/auth/verify", { chain: "solana", address, signature: sig });
    expect(replay.statusCode).toBe(401);
  });

  it("rejects a malformed address up front", async () => {
    const c = new Client(t.app);
    expect((await c.post("/api/auth/challenge", { chain: "solana", address: "not-base58-!!" })).statusCode).toBe(400);
    expect((await c.post("/api/auth/challenge", { chain: "ethereum", address: "0xnothex" })).statusCode).toBe(400);
  });

  it("new sign-ups can be disabled while existing wallets keep logging in", async () => {
    const t2 = await makeApp({ allowSignup: false });
    const blocked = await solanaLogin(new Client(t2.app), "newcomer");
    expect(blocked.res.statusCode).toBe(403);
    expect((await t2.app.inject({ method: "GET", url: "/api/health" })).json().allowSignup).toBe(false);
    // An account created before the toggle was flipped can still log in.
    const { address } = testWallet("grandfathered");
    const now = new Date().toISOString();
    t2.ctx.db.run("INSERT INTO users (id, username, display_name, created_at, updated_at, chain, wallet_address) VALUES ('u1', 'grandfathered', 'grandfathered', ?, ?, 'solana', ?)", now, now, address);
    const allowed = await solanaLogin(new Client(t2.app), "grandfathered");
    expect(allowed.res.statusCode).toBe(200);
    await t2.close();
  });

  it("throttles verify failures after 5 per (ip, wallet)", async () => {
    const c = new Client(t.app);
    const { address } = testWallet("frank");
    for (let i = 0; i < 5; i++) {
      await c.post("/api/auth/challenge", { chain: "solana", address });
      expect((await c.post("/api/auth/verify", { chain: "solana", address, signature: Buffer.from(new Uint8Array(64)).toString("base64") })).statusCode).toBe(401);
    }
    await c.post("/api/auth/challenge", { chain: "solana", address });
    const locked = await c.post("/api/auth/verify", { chain: "solana", address, signature: Buffer.from(new Uint8Array(64)).toString("base64") });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe("rate_limited");
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("CSRF: mutating requests need an allowed Origin (or Referer) and a JSON content type", async () => {
    const { address } = testWallet("grace");
    const noOrigin = await t.app.inject({ method: "POST", url: "/api/auth/challenge", headers: { "content-type": "application/json" }, payload: JSON.stringify({ chain: "solana", address }) });
    expect(noOrigin.statusCode).toBe(403);
    const evil = await t.app.inject({ method: "POST", url: "/api/auth/challenge", headers: { origin: "https://evil.example", "content-type": "application/json" }, payload: "{}" });
    expect(evil.statusCode).toBe(403);
    const form = await t.app.inject({
      method: "POST",
      url: "/api/auth/challenge",
      headers: { origin: ORIGIN, "content-type": "text/plain" },
      payload: JSON.stringify({ chain: "solana", address }),
    });
    expect(form.statusCode).toBe(415);
    const referer = await t.app.inject({
      method: "POST",
      url: "/api/auth/challenge",
      headers: { referer: `${ORIGIN}/login`, "content-type": "application/json" },
      payload: JSON.stringify({ chain: "solana", address }),
    });
    expect(referer.statusCode).toBe(200);
    const sameOrigin = await t.app.inject({ method: "POST", url: "/api/auth/logout", headers: { origin: "http://localhost:80", host: "localhost:80" } });
    expect(sameOrigin.statusCode).toBe(204);
    // GETs are not origin-checked; errors never leak stack traces
    const nf = await t.app.inject({ method: "GET", url: "/api/nope" });
    expect(nf.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
    const bad = await t.app.inject({ method: "POST", url: "/api/auth/verify", headers: { origin: ORIGIN, "content-type": "application/json" }, payload: "{not json" });
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

  it("sessions can be listed and revoked; another user's session id is a 404", async () => {
    const a = await signup(t.app, "gina");
    const b = new Client(t.app);
    await solanaLogin(b, "gina");
    const list = (await a.get("/api/auth/sessions")).json() as { id: string; current: boolean }[];
    expect(list).toHaveLength(2);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    const other = await signup(t.app, "hank");
    expect((await other.del(`/api/auth/sessions/${list[0]!.id}`)).statusCode).toBe(404);
    const theirs = (await b.get("/api/auth/sessions")).json() as { id: string; current: boolean }[];
    const current = theirs.find((s) => s.current)!;
    expect((await b.del(`/api/auth/sessions/${current.id}`)).statusCode).toBe(204);
    expect((await b.get("/api/auth/me")).statusCode).toBe(401);
  });

  it("deleting the account needs only a valid session and cascades every user-owned row", async () => {
    const a = await signup(t.app, "ivan");
    await a.post("/api/labels", { chain: "ethereum", address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", name: "x" });
    await a.post("/api/traces", { initialAddress: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" });
    await a.post("/api/tags", { name: "t" });
    expect((await a.del("/api/auth/account")).statusCode).toBe(204);
    for (const table of ["users", "sessions", "labels", "traces", "trace_nodes", "tags", "notification_methods"]) {
      expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n, table).toBe(0);
    }
  });
});
