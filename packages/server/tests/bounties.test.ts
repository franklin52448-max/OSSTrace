import { describe, expect, it } from "vitest";
import { Wallet } from "ethers";
import nacl from "tweetnacl";
import type { FastifyInstance } from "fastify";
import { loadConfig, type Config } from "../src/config.ts";
import { buildApp } from "../src/app.ts";
import { openDb } from "../src/db/index.ts";
import { PriceService } from "../src/chain/prices.ts";
import { Client, FakeProvider, llamaFetch, signup, testWallet } from "./helpers.ts";

/** Runs the real challenge -> sign -> verify flow for an Ethereum wallet and returns a signed-in client. */
async function signupEthereum(app: FastifyInstance, wallet: Wallet): Promise<Client> {
  const c = new Client(app);
  const address = wallet.address;
  const chal = await c.post("/api/auth/challenge", { chain: "ethereum", address });
  if (chal.statusCode !== 200) throw new Error(`challenge failed: ${chal.statusCode} ${chal.body}`);
  const { message } = chal.json() as { message: string };
  const signature = await wallet.signMessage(message);
  const r = await c.post("/api/auth/verify", { chain: "ethereum", address, signature });
  if (r.statusCode !== 200) throw new Error(`verify failed: ${r.statusCode} ${r.body}`);
  return c;
}

const SOL_WALLET = "11111111111111111111111111111111";
const ETH_WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

/** Mocks the two deposit-verification upstreams: Solana's getParsedTransaction RPC, and Blockscout's tx/token-transfer REST endpoints. */
function depositFetch(opts: { solTx?: unknown; bsTx?: unknown; bsTransfers?: unknown }): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      return new Response(JSON.stringify({ result: opts.solTx ?? null }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/token-transfers")) return new Response(JSON.stringify(opts.bsTransfers ?? { items: [] }), { status: 200 });
    if (url.includes("/api/v2/transactions/")) return new Response(JSON.stringify(opts.bsTx ?? { status: null, value: "0", to: null, from: null }), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function makeBountyApp(fetchImpl: typeof fetch, eth: FakeProvider, sol: FakeProvider, over: Partial<Config> = {}) {
  const config = { ...loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), dbPath: ":memory:", depositWallets: { solana: SOL_WALLET, ethereum: ETH_WALLET }, ...over };
  const db = openDb(":memory:");
  const { app } = await buildApp(config, {
    db,
    providers: { ethereum: eth, solana: sol },
    prices: new PriceService(db, "https://prices.test", llamaFetch()),
    resolver: async () => [{ address: "10.0.0.5", family: 4 }],
    fetchImpl,
    logger: false,
  });
  await app.ready();
  return { app, close: async () => { await app.close(); db.close(); } };
}

describe("bounties", () => {
  it("open -> submit -> claim: full lifecycle, authorization enforced", async () => {
    const { app, close } = await makeBountyApp(depositFetch({}), new FakeProvider("ethereum"), new FakeProvider("solana"));
    try {
      const opener = await signup(app, "opener");
      const claimant = await signup(app, "claimant");
      const stranger = await signup(app, "stranger");

      const anon = new Client(app);
      expect((await anon.get("/api/bounties")).json()).toEqual([]);

      const opened = (await opener.post("/api/bounties", { title: "Build X", description: "Spec...", reward: "100,000 tokens" })).json();
      expect(opened).toMatchObject({ status: "open", title: "Build X", submissions: [], deposits: [] });

      // anyone can browse without signing in
      expect((await anon.get("/api/bounties")).json()).toHaveLength(1);
      expect((await anon.get(`/api/bounties/${opened.id}`)).json().id).toBe(opened.id);

      const sub = (await claimant.post(`/api/bounties/${opened.id}/submissions`, { prUrl: "https://github.com/x/y/pull/1", note: "done" })).json();
      expect(sub).toMatchObject({ outcome: "pending", prUrl: "https://github.com/x/y/pull/1" });

      // a stranger (not the opener) can't accept the submission
      const forbidden = await stranger.post(`/api/bounties/${opened.id}/claim`, { submissionId: sub.id });
      expect(forbidden.statusCode).toBe(403);

      const claimed = (await opener.post(`/api/bounties/${opened.id}/claim`, { submissionId: sub.id })).json();
      expect(claimed).toMatchObject({ status: "claimed", claimedSubmissionId: sub.id, claimedBy: sub.submittedBy, resolvedBy: opened.openedBy });

      // can't submit against a bounty that's no longer open
      const late = await stranger.post(`/api/bounties/${opened.id}/submissions`, { prUrl: "https://github.com/x/y/pull/2" });
      expect(late.statusCode).toBe(409);
    } finally {
      await close();
    }
  });

  it("opener can cancel their own open bounty; nobody else can", async () => {
    const stub = new FakeProvider("ethereum");
    const { app, close } = await makeBountyApp(depositFetch({}), stub, stub);
    try {
      const opener = await signup(app, "cancel-opener");
      const other = await signup(app, "cancel-other");
      const b = (await opener.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
      expect((await other.post(`/api/bounties/${b.id}/cancel`, { reason: "nope" })).statusCode).toBe(403);
      const cancelled = (await opener.post(`/api/bounties/${b.id}/cancel`, { reason: "changed my mind" })).json();
      expect(cancelled).toMatchObject({ status: "cancelled", cancellationReason: "changed my mind" });
    } finally {
      await close();
    }
  });

  it("records a real verified Solana native deposit, rejects a replay, a malformed signature, and someone else's transaction", async () => {
    const stub = new FakeProvider("solana");
    // The signed-in depositor's own wallet is the tx's real sender -- the deposit route now requires
    // that match (previously it didn't, letting anyone attach any public on-chain payment to any bounty).
    const payer = testWallet("depositor");
    const solTx = {
      transaction: { message: { accountKeys: [payer.address, SOL_WALLET], instructions: [] } },
      meta: { err: null, preBalances: [5_000_000_000, 1_000_000_000], postBalances: [3_998_000_000, 2_000_000_000] },
    };
    const { app, close } = await makeBountyApp(depositFetch({ solTx }), stub, stub);
    try {
      const u = new Client(app);
      const chal = await u.post("/api/auth/challenge", { chain: "solana", address: payer.address });
      const { message } = chal.json() as { message: string };
      const signature = Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), payer.secretKey)).toString("base64");
      await u.post("/api/auth/verify", { chain: "solana", address: payer.address, signature });
      const b = (await u.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();

      const fakeSig = "A".repeat(64); // valid base58 charset + length, so it routes into real RPC verification (mocked above)
      const good = await u.post(`/api/bounties/${b.id}/deposits`, { chain: "solana", txRef: fakeSig });
      expect(good.statusCode).toBe(201);
      expect(good.json()).toMatchObject({ asset: "native", amount: "1", toWallet: SOL_WALLET, fromAddress: payer.address }); // 2_000_000_000 - 1_000_000_000 lamports = 1 SOL

      // replay of the same tx_ref is rejected
      const replay = await u.post(`/api/bounties/${b.id}/deposits`, { chain: "solana", txRef: fakeSig });
      expect(replay.statusCode).toBe(409);

      // malformed signature is rejected without even hitting the RPC
      const malformed = await u.post(`/api/bounties/${b.id}/deposits`, { chain: "solana", txRef: "not-a-real-signature" });
      expect(malformed.statusCode).toBe(400);

      // a different signed-in user can't attach THIS (real, public) payment to their own bounty --
      // the tx really happened on-chain, but it wasn't sent from their wallet.
      const stranger = await signup(app, "stranger-watching-the-wallet");
      const strangersBounty = (await stranger.post("/api/bounties", { title: "T2", description: "D", reward: "R" })).json();
      const stolen = await stranger.post(`/api/bounties/${strangersBounty.id}/deposits`, { chain: "solana", txRef: "B".repeat(64) });
      expect(stolen.statusCode).toBe(403);
      expect(stolen.json().error.message).toMatch(/sent from your connected wallet/i);
    } finally {
      await close();
    }
  });

  it("records a real verified Ethereum ERC-20 deposit via Blockscout, with decimals already resolved", async () => {
    const stub = new FakeProvider("ethereum");
    const wallet = new Wallet("0x" + "7".repeat(64));
    const sender = wallet.address;
    const bsTx = { status: "ok", value: "0", to: { hash: ETH_WALLET }, from: { hash: sender } };
    const bsTransfers = { items: [{ to: { hash: ETH_WALLET }, from: { hash: sender }, token: { address_hash: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: "6" }, total: { value: "5500000" } }] };
    const { app, close } = await makeBountyApp(depositFetch({ bsTx, bsTransfers }), stub, stub);
    try {
      const u = await signupEthereum(app, wallet);
      const b = (await u.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
      const r = await u.post(`/api/bounties/${b.id}/deposits`, { chain: "ethereum", txRef: `0x${"a".repeat(64)}` });
      expect(r.statusCode).toBe(201);
      expect(r.json()).toMatchObject({ asset: { contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }, amount: "5.5", fromAddress: sender, toWallet: ETH_WALLET }); // raw 5_500_000 at 6 decimals
    } finally {
      await close();
    }
  });

  it("deposit is refused with a clear error when no wallet is configured for that chain", async () => {
    const stub = new FakeProvider("ethereum");
    const { app, close } = await makeBountyApp(depositFetch({}), stub, stub, { depositWallets: {} });
    try {
      const u = await signup(app, "no-wallet-configured");
      const b = (await u.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
      const r = await u.post(`/api/bounties/${b.id}/deposits`, { chain: "ethereum", txRef: `0x${"b".repeat(64)}` });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.message).toMatch(/no ethereum deposit wallet/i);
    } finally {
      await close();
    }
  });
});
