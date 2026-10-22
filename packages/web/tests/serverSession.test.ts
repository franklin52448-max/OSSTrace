import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Wallet } from "ethers";
import "./harness/env.ts"; // registers the import.meta.env injection hook serverSession.ts needs, before its first dynamic import below
import { startNewServer, type RunningNewServer } from "./harness/newServer.ts";

/**
 * serverSession.ts against a real, booted @osstrace/server instance (ADR 0022) — real Fastify,
 * real in-memory SQLite, real challenge/verify/me/logout, real CORS headers.
 *
 * What this file does NOT cover: a session surviving a fresh page load. That needs a real
 * browser's cookie jar — Node's own `fetch` (what env.ts gives these tests, see its own doc
 * comment) has no cookie store at all, so a Set-Cookie from one request is never resent on the
 * next one here, unlike a real browser. That round trip was verified instead by driving the real
 * UI in headless Chromium against this same server (connect a wallet, reload-equivalent
 * navigation, still authenticated, a real address's real balances and transfers rendered).
 */
type ServerSessionModule = typeof import("../src/serverSession.ts");

let server: RunningNewServer;
let loads = 0;

function solanaWallet(seed: string): { address: string; secretKey: Uint8Array } {
  const kp = nacl.sign.keyPair.fromSeed(createHash("sha256").update(seed).digest());
  return { address: bs58.encode(Buffer.from(kp.publicKey)), secretKey: kp.secretKey };
}

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

test("a challenge request with no origin allowance is refused by the real CSRF/CORS check — must send an allowed Origin", async () => {
  const mod = await freshServerSession(server.url);
  const { address } = solanaWallet(`nosendorigin${Date.now()}`);
  // serverChallenge itself doesn't set an Origin header (that's the browser's job); confirm the
  // real server's behaviour this app depends on: no Origin on a mutating request is refused.
  const result = await mod.serverChallenge("solana", address);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /origin/i);
});

test("a real challenge -> verify against an origin the server allows succeeds and returns the real user", async () => {
  // This server instance allows http://localhost:5301 (set in before()); emulate the browser
  // sending that Origin on the mutating request the way a real page served from there would.
  const { address, secretKey } = solanaWallet(`chalok${Date.now()}`);
  const chal = await fetch(`${server.url}/api/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5301" },
    body: JSON.stringify({ chain: "solana", address }),
  });
  assert.equal(chal.status, 200);
  const { message } = (await chal.json()) as { message: string };
  const signature = Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), secretKey)).toString("base64");
  const res = await fetch(`${server.url}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5301" },
    body: JSON.stringify({ chain: "solana", address, signature }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { user: { chain: string; walletAddress: string } };
  assert.equal(body.user.chain, "solana");
  assert.equal(body.user.walletAddress, address);
  assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:5301");
  assert.equal(res.headers.get("access-control-allow-credentials"), "true");
});

test("an ethereum wallet verifies with a real secp256k1 signature too", async () => {
  const wallet = new Wallet("0x" + createHash("sha256").update(`eth${Date.now()}`).digest("hex"));
  const chal = await fetch(`${server.url}/api/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5301" },
    body: JSON.stringify({ chain: "ethereum", address: wallet.address }),
  });
  const { message } = (await chal.json()) as { message: string };
  const signature = await wallet.signMessage(message);
  const res = await fetch(`${server.url}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5301" },
    body: JSON.stringify({ chain: "ethereum", address: wallet.address, signature }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { user: { chain: string; walletAddress: string } };
  assert.equal(body.user.chain, "ethereum");
  assert.equal(body.user.walletAddress, wallet.address.toLowerCase());
});

test("a wrong signature is refused with the real 401 message, same wording whether or not the wallet has an account yet (no enumeration signal)", async () => {
  const known = solanaWallet(`known${Date.now()}`);
  const unknown = solanaWallet(`unknown${Date.now()}`);
  // Give `known` an account first.
  const chal0 = await fetch(`${server.url}/api/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5301" },
    body: JSON.stringify({ chain: "solana", address: known.address }),
  });
  const { message: msg0 } = (await chal0.json()) as { message: string };
  const sig0 = Buffer.from(nacl.sign.detached(new TextEncoder().encode(msg0), known.secretKey)).toString("base64");
  await fetch(`${server.url}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5301" },
    body: JSON.stringify({ chain: "solana", address: known.address, signature: sig0 }),
  });

  async function wrongSigAttempt(w: { address: string; secretKey: Uint8Array }): Promise<Response> {
    const chal = await fetch(`${server.url}/api/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5301" },
      body: JSON.stringify({ chain: "solana", address: w.address }),
    });
    const { message } = (await chal.json()) as { message: string };
    // Sign with the WRONG key.
    const badSig = Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), solanaWallet("someone-else").secretKey)).toString("base64");
    return fetch(`${server.url}/api/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5301" },
      body: JSON.stringify({ chain: "solana", address: w.address, signature: badSig }),
    });
  }

  const knownBad = await wrongSigAttempt(known);
  const unknownBad = await wrongSigAttempt(unknown);
  assert.equal(knownBad.status, 401);
  assert.equal(unknownBad.status, 401);
  const a = (await knownBad.json()) as { error: { message: string } };
  const b = (await unknownBad.json()) as { error: { message: string } };
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
