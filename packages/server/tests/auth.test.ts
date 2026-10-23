import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";
import { Wallet } from "ethers";
import { Client, makeApp, ORIGIN, signup, testWallet, type TestApp } from "./helpers.ts";

type Challenge = { message: string; nonce: string };
const signSolana = (message: string, secretKey: Uint8Array) => Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), secretKey)).toString("base64");
const ZERO_SIG = Buffer.from(new Uint8Array(64)).toString("base64");

async function solanaChallenge(c: Client, address: string): Promise<Challenge> {
  return (await c.post("/api/auth/challenge", { chain: "solana", address })).json() as Challenge;
}

async function solanaLogin(c: Client, seed: string) {
  const { address, secretKey } = testWallet(seed);
  const { message, nonce } = await solanaChallenge(c, address);
  return { res: await c.post("/api/auth/verify", { chain: "solana", address, nonce, signature: signSolana(message, secretKey) }), address };
}

async function ethereumLogin(c: Client, wallet: Wallet) {
  const address = wallet.address;
  const chal = await c.post("/api/auth/challenge", { chain: "ethereum", address });
  const { message, nonce } = chal.json() as Challenge;
  const signature = await wallet.signMessage(message);
  return { res: await c.post("/api/auth/verify", { chain: "ethereum", address, nonce, signature }), address };
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

  it("ethereum: the challenge message is a spec-correct EIP-4361 (SIWE) message, not a generic string -- this is", async () => {
    // what gets MetaMask/other wallets' own "Sign-in request" UI instead of a generic, more
    // suspicious-looking "unusual message" prompt.
    const ethAddress = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    const c = new Client(t.app);
    const chal = await c.post("/api/auth/challenge", { chain: "ethereum", address: ethAddress });
    const { message } = chal.json() as { message: string };
    const host = new URL(ORIGIN).host;
    expect(message.split("\n")[0]).toBe(`${host} wants you to sign in with your Ethereum account:`);
    expect(message).toContain(`\n${ethAddress}\n\n`);
    expect(message).toMatch(/\nURI: http:\/\/127\.0\.0\.1:5301\n/);
    expect(message).toContain("\nVersion: 1\n");
    expect(message).toContain("\nChain ID: 1\n");
    expect(message).toMatch(/\nNonce: [0-9a-f]{32}\n/);
    expect(message).toMatch(/\nIssued At: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  });

  it("solana: the challenge message is a Sign-In-With-Solana (SIWS) message with the real domain fixed into the signed text -- without this, a phishing site can relay a real challenge and steal the resulting session", async () => {
    const { address } = testWallet("domain-binding-check");
    const c = new Client(t.app);
    const chal = await c.post("/api/auth/challenge", { chain: "solana", address });
    const { message } = chal.json() as { message: string };
    const host = new URL(ORIGIN).host;
    expect(message.split("\n")[0]).toBe(`${host} wants you to sign in with your Solana account:`);
    expect(message).toContain(`\n${address}\n\n`);
    expect(message).toMatch(/\nURI: http:\/\/127\.0\.0\.1:5301\n/);
    expect(message).toContain("\nVersion: 1\n");
    expect(message).toContain("\nChain ID: mainnet\n");
    expect(message).toMatch(/\nNonce: [0-9a-f]{32}\n/);
    expect(message).toMatch(/\nIssued At: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
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

    // A well-formed nonce that was never issued.
    const noChallenge = await c.post("/api/auth/verify", { chain: "solana", address, nonce: "0".repeat(32), signature: ZERO_SIG });
    expect(noChallenge.statusCode).toBe(401);

    const chal = await solanaChallenge(c, address);
    // The returned nonce is the message's own `Nonce:` line, not a second value.
    expect(chal.message).toContain(`\nNonce: ${chal.nonce}\n`);

    // Signed with the WRONG key for this address.
    expect((await c.post("/api/auth/verify", { chain: "solana", address, nonce: chal.nonce, signature: signSolana(chal.message, other.secretKey) })).statusCode).toBe(401);

    // Correct signature: the earlier attempt already consumed the nonce, so a fresh challenge is needed.
    const stale = await c.post("/api/auth/verify", { chain: "solana", address, nonce: chal.nonce, signature: signSolana(chal.message, secretKey) });
    expect(stale.statusCode).toBe(401);
    const chal2 = await solanaChallenge(c, address);
    const sig = signSolana(chal2.message, secretKey);
    const ok = await c.post("/api/auth/verify", { chain: "solana", address, nonce: chal2.nonce, signature: sig });
    expect(ok.statusCode).toBe(200);

    // Replaying the same (now-consumed) challenge/signature fails.
    const replay = await c.post("/api/auth/verify", { chain: "solana", address, nonce: chal2.nonce, signature: sig });
    expect(replay.statusCode).toBe(401);

    // A missing or malformed nonce is a 400, not a lookup.
    expect((await c.post("/api/auth/verify", { chain: "solana", address, signature: sig })).statusCode).toBe(400);
    expect((await c.post("/api/auth/verify", { chain: "solana", address, nonce: "not-a-nonce", signature: sig })).statusCode).toBe(400);
  });

  it("challenges are keyed by nonce, not address: a second challenge -- for another wallet, or the SAME wallet by someone else -- never invalidates one already in flight", async () => {
    const alice = testWallet("nonce-alice");
    const bob = testWallet("nonce-bob");
    const aliceClient = new Client(t.app);
    const bobClient = new Client(t.app);

    // Interleaved: both request before either verifies.
    const aliceChal = await solanaChallenge(aliceClient, alice.address);
    const bobChal = await solanaChallenge(bobClient, bob.address);
    expect(aliceChal.nonce).not.toBe(bobChal.nonce);

    // The griefing case this fixes: someone else requests fresh challenges for Alice's address
    // while she's still signing. With address-keyed challenges each of these overwrote hers.
    const griefer = new Client(t.app);
    for (let i = 0; i < 3; i++) expect((await griefer.post("/api/auth/challenge", { chain: "solana", address: alice.address })).statusCode).toBe(200);

    const bobRes = await bobClient.post("/api/auth/verify", { chain: "solana", address: bob.address, nonce: bobChal.nonce, signature: signSolana(bobChal.message, bob.secretKey) });
    expect(bobRes.statusCode).toBe(200);
    const aliceRes = await aliceClient.post("/api/auth/verify", { chain: "solana", address: alice.address, nonce: aliceChal.nonce, signature: signSolana(aliceChal.message, alice.secretKey) });
    expect(aliceRes.statusCode).toBe(200);
    expect(aliceRes.json().user.walletAddress).toBe(alice.address);
    expect(bobRes.json().user.walletAddress).toBe(bob.address);
  });

  it("rejects a nonce that names a different challenge than the one signed, one issued for another wallet, and an expired one", async () => {
    const alice = testWallet("nonce-wrong-alice");
    const bob = testWallet("nonce-wrong-bob");
    const c = new Client(t.app);

    // Two pending challenges for the same wallet: signing the first but naming the second fails
    // (the signature is checked against the message the nonce names), and spends that second one.
    const first = await solanaChallenge(c, alice.address);
    const second = await solanaChallenge(c, alice.address);
    const crossed = await c.post("/api/auth/verify", { chain: "solana", address: alice.address, nonce: second.nonce, signature: signSolana(first.message, alice.secretKey) });
    expect(crossed.statusCode).toBe(401);
    expect((await c.post("/api/auth/verify", { chain: "solana", address: alice.address, nonce: second.nonce, signature: signSolana(second.message, alice.secretKey) })).statusCode).toBe(401);

    // A nonce issued for Bob can't be spent signing in as Alice, even with Alice's own valid
    // signature over that exact message.
    const bobs = await solanaChallenge(c, bob.address);
    expect((await c.post("/api/auth/verify", { chain: "solana", address: alice.address, nonce: bobs.nonce, signature: signSolana(bobs.message, alice.secretKey) })).statusCode).toBe(401);

    // Expired: past the 5-minute TTL, a correctly signed challenge no longer verifies.
    const late = await solanaChallenge(c, alice.address);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 5 * 60_000 + 1000 });
    try {
      expect((await c.post("/api/auth/verify", { chain: "solana", address: alice.address, nonce: late.nonce, signature: signSolana(late.message, alice.secretKey) })).statusCode).toBe(401);
    } finally {
      vi.useRealTimers();
    }

    // The first, untouched challenge is still good.
    const ok = await c.post("/api/auth/verify", { chain: "solana", address: alice.address, nonce: first.nonce, signature: signSolana(first.message, alice.secretKey) });
    expect(ok.statusCode).toBe(200);
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
      const { nonce } = await solanaChallenge(c, address);
      expect((await c.post("/api/auth/verify", { chain: "solana", address, nonce, signature: ZERO_SIG })).statusCode).toBe(401);
    }
    const { nonce } = await solanaChallenge(c, address);
    const locked = await c.post("/api/auth/verify", { chain: "solana", address, nonce, signature: ZERO_SIG });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe("rate_limited");
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("throttles challenge requests at 10/hour per ip, but never per wallet address -- many ips asking for one wallet can't lock its owner out", async () => {
    // Through the real route once, proving the per-ip cap is actually wired in.
    const c = new Client(t.app);
    for (let i = 0; i < 10; i++) expect((await c.post("/api/auth/challenge", { chain: "solana", address: testWallet(`per-ip-${i}`).address })).statusCode).toBe(200);
    const blocked = await c.post("/api/auth/challenge", { chain: "solana", address: testWallet("per-ip-11th").address });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("rate_limited");

    // 15 challenges for ONE target wallet, each from a different ip (each well under its own per-ip
    // cap): none is refused. Under the old per-address cap (10/hour, counted across all ips) the
    // 11th was, which let anyone burn a wallet's hourly allowance and block its real owner.
    const victim = testWallet("lockout-victim");
    const fromIp = (ip: string) =>
      t.app.inject({ method: "POST", url: "/api/auth/challenge", remoteAddress: ip, headers: { origin: ORIGIN, "content-type": "application/json" }, payload: JSON.stringify({ chain: "solana", address: victim.address }) });
    for (let i = 0; i < 15; i++) expect((await fromIp(`10.0.1.${i}`)).statusCode).toBe(200);

    // ...and the real owner, from their own ip, still gets a challenge and signs in with it.
    const own = await fromIp("192.0.2.7");
    expect(own.statusCode).toBe(200);
    const { message, nonce } = own.json() as Challenge;
    const signedIn = await t.app.inject({
      method: "POST",
      url: "/api/auth/verify",
      remoteAddress: "192.0.2.7",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      payload: JSON.stringify({ chain: "solana", address: victim.address, nonce, signature: signSolana(message, victim.secretKey) }),
    });
    expect(signedIn.statusCode).toBe(200);
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
