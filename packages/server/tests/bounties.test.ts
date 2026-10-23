import { describe, expect, it } from "vitest";
import { Wallet } from "ethers";
import nacl from "tweetnacl";
import type { FastifyInstance } from "fastify";
import { loadConfig, type Config } from "../src/config.ts";
import { buildApp } from "../src/app.ts";
import { openDb } from "../src/db/index.ts";
import { PriceService } from "../src/chain/prices.ts";
import { verifySolanaDeposit, DEFAULT_ALLOWED_TOKENS_SOLANA } from "../src/chain/deposits.ts";
import { HttpClient, budgetMs } from "../src/lib/http.ts";
import { Client, FakeProvider, llamaFetch, signup, testWallet } from "./helpers.ts";

/** Runs the real challenge -> sign -> verify flow for an Ethereum wallet and returns a signed-in client. */
async function signupEthereum(app: FastifyInstance, wallet: Wallet): Promise<Client> {
  const c = new Client(app);
  const address = wallet.address;
  const chal = await c.post("/api/auth/challenge", { chain: "ethereum", address });
  if (chal.statusCode !== 200) throw new Error(`challenge failed: ${chal.statusCode} ${chal.body}`);
  const { message, nonce } = chal.json() as { message: string; nonce: string };
  const signature = await wallet.signMessage(message);
  const r = await c.post("/api/auth/verify", { chain: "ethereum", address, nonce, signature });
  if (r.statusCode !== 200) throw new Error(`verify failed: ${r.statusCode} ${r.body}`);
  return c;
}

const SOL_WALLET = "11111111111111111111111111111111";
const ETH_WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const BTC_WALLET = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

/** Mocks the three deposit-verification upstreams: Solana's getParsedTransaction RPC, Blockscout's
 *  tx/token-transfer REST endpoints, and an Esplora explorer's `/api/tx/:txid` (404 when `btcTx` is
 *  unset, the same as Blockstream.info answers for a txid it doesn't know). */
function depositFetch(opts: { solTx?: unknown; bsTx?: unknown; bsTransfers?: unknown; btcTx?: unknown }): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      return new Response(JSON.stringify({ result: opts.solTx ?? null }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/api/tx/")) {
      return opts.btcTx ? new Response(JSON.stringify(opts.btcTx), { status: 200, headers: { "content-type": "application/json" } }) : new Response("Transaction not found", { status: 404 });
    }
    if (url.includes("/token-transfers")) return new Response(JSON.stringify(opts.bsTransfers ?? { items: [] }), { status: 200 });
    if (url.includes("/api/v2/transactions/")) return new Response(JSON.stringify(opts.bsTx ?? { status: null, value: "0", to: null, from: null }), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function makeBountyApp(fetchImpl: typeof fetch, eth: FakeProvider, sol: FakeProvider, over: Partial<Config> = {}) {
  const config = { ...loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), dbPath: ":memory:", depositWallets: { solana: SOL_WALLET, ethereum: ETH_WALLET, bitcoin: BTC_WALLET }, ...over };
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
      const { message, nonce } = chal.json() as { message: string; nonce: string };
      const signature = Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), payer.secretKey)).toString("base64");
      await u.post("/api/auth/verify", { chain: "solana", address: payer.address, nonce, signature });
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

  it("ETH dedupe is case-insensitive -- the real sender can't get one real payment recorded twice by resubmitting it with different letter-casing", async () => {
    const stub = new FakeProvider("ethereum");
    const wallet = new Wallet("0x" + "7".repeat(64));
    const sender = wallet.address;
    const bsTx = { status: "ok", value: "0", to: { hash: ETH_WALLET }, from: { hash: sender } };
    const bsTransfers = { items: [{ to: { hash: ETH_WALLET }, from: { hash: sender }, token: { address_hash: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: "6" }, total: { value: "5500000" } }] };
    const { app, close } = await makeBountyApp(depositFetch({ bsTx, bsTransfers }), stub, stub);
    try {
      const u = await signupEthereum(app, wallet);
      const b = (await u.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
      const hashLower = `0x${"c".repeat(64)}`;
      const first = await u.post(`/api/bounties/${b.id}/deposits`, { chain: "ethereum", txRef: hashLower });
      expect(first.statusCode).toBe(201);
      const hashUpper = `0x${"C".repeat(64)}`; // same tx hash, different letter-casing -- same real on-chain transaction
      const second = await u.post(`/api/bounties/${b.id}/deposits`, { chain: "ethereum", txRef: hashUpper });
      expect(second.statusCode).toBe(409);
      expect(second.json().error.message).toMatch(/already been recorded/i);
    } finally {
      await close();
    }
  });

  it("a deposit in a token this server doesn't track (not native, not an allowlisted USDC/USDT) is rejected, even though a real transfer happened", async () => {
    const stub = new FakeProvider("ethereum");
    const wallet = new Wallet("0x" + "7".repeat(64));
    const sender = wallet.address;
    const JUNK_TOKEN = "0xBAD0000000000000000000000000000000bAd0";
    const bsTx = { status: "ok", value: "0", to: { hash: ETH_WALLET }, from: { hash: sender } };
    const bsTransfers = { items: [{ to: { hash: ETH_WALLET }, from: { hash: sender }, token: { address_hash: JUNK_TOKEN, decimals: "18" }, total: { value: "1000000000000000000000000" } }] };
    const { app, close } = await makeBountyApp(depositFetch({ bsTx, bsTransfers }), stub, stub);
    try {
      const u = await signupEthereum(app, wallet);
      const b = (await u.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
      const r = await u.post(`/api/bounties/${b.id}/deposits`, { chain: "ethereum", txRef: `0x${"d".repeat(64)}` });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.message).toMatch(/not.*an asset this server tracks/i);
    } finally {
      await close();
    }
  });

  it("a tx carrying both a junk transfer and a real allowlisted one still finds the real one, instead of taking whichever comes first", async () => {
    const stub = new FakeProvider("ethereum");
    const wallet = new Wallet("0x" + "7".repeat(64));
    const sender = wallet.address;
    const JUNK_TOKEN = "0xBAD0000000000000000000000000000000bAd0";
    const bsTx = { status: "ok", value: "0", to: { hash: ETH_WALLET }, from: { hash: sender } };
    const bsTransfers = {
      items: [
        { to: { hash: ETH_WALLET }, from: { hash: sender }, token: { address_hash: JUNK_TOKEN, decimals: "18" }, total: { value: "999999999999999999999999" } },
        { to: { hash: ETH_WALLET }, from: { hash: sender }, token: { address_hash: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: "6" }, total: { value: "5500000" } },
      ],
    };
    const { app, close } = await makeBountyApp(depositFetch({ bsTx, bsTransfers }), stub, stub);
    try {
      const u = await signupEthereum(app, wallet);
      const b = (await u.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
      const r = await u.post(`/api/bounties/${b.id}/deposits`, { chain: "ethereum", txRef: `0x${"e".repeat(64)}` });
      expect(r.statusCode).toBe(201);
      expect(r.json()).toMatchObject({ asset: { contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }, amount: "5.5" });
    } finally {
      await close();
    }
  });

  it("a deposit can't be recorded against a bounty that's no longer open", async () => {
    const stub = new FakeProvider("ethereum");
    const wallet = new Wallet("0x" + "7".repeat(64));
    const sender = wallet.address;
    const bsTx = { status: "ok", value: "0", to: { hash: ETH_WALLET }, from: { hash: sender } };
    const bsTransfers = { items: [{ to: { hash: ETH_WALLET }, from: { hash: sender }, token: { address_hash: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: "6" }, total: { value: "5500000" } }] };
    const { app, close } = await makeBountyApp(depositFetch({ bsTx, bsTransfers }), stub, stub);
    try {
      const u = await signupEthereum(app, wallet);
      const b = (await u.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
      const cancelled = await u.post(`/api/bounties/${b.id}/cancel`, { reason: "no longer needed" });
      expect(cancelled.statusCode).toBe(200);
      const r = await u.post(`/api/bounties/${b.id}/deposits`, { chain: "ethereum", txRef: `0x${"f".repeat(64)}` });
      expect(r.statusCode).toBe(409);
      expect(r.json().error.message).toMatch(/no longer open/i);
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

  describe("Bitcoin deposits (paste-a-txid only, no sender-ownership check -- ADR 0020 addendum)", () => {
    const TXID = "ab".repeat(32); // 64 hex chars -- routes into the (mocked) Esplora lookup
    const SENDER = "bc1qsomeoneelsesinput0000000000000000000000";
    /** An Esplora `/api/tx/:txid` body: two outputs pay the configured wallet (summed), one is change. */
    const btcTx = (over: { confirmed?: boolean; vout?: { scriptpubkey_address?: string; value: number }[] } = {}) => ({
      status: { confirmed: over.confirmed ?? true },
      vin: [{ prevout: { scriptpubkey_address: SENDER } }],
      vout: over.vout ?? [
        { scriptpubkey_address: BTC_WALLET, value: 150_000 },
        { scriptpubkey_address: SENDER, value: 9_000_000 },
        { scriptpubkey_address: BTC_WALLET, value: 50_000 },
      ],
    });

    it("records a confirmed tx paying the configured wallet, summing every output to it; refuses a re-submission under different letter-casing", async () => {
      const stub = new FakeProvider("solana");
      const { app, close } = await makeBountyApp(depositFetch({ btcTx: btcTx() }), stub, stub);
      try {
        const u = await signup(app, "btc-backer");
        const b = (await u.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
        const r = await u.post(`/api/bounties/${b.id}/deposits`, { chain: "bitcoin", txRef: TXID });
        expect(r.statusCode).toBe(201);
        // 150_000 + 50_000 sats = 0.002 BTC; the 9_000_000-sat change output back to the sender isn't counted.
        expect(r.json()).toMatchObject({ chain: "bitcoin", asset: "native", amount: "0.002", txRef: TXID, fromAddress: SENDER, toWallet: BTC_WALLET });
        expect((await u.get(`/api/bounties/${b.id}`)).json().deposits).toHaveLength(1);

        const again = await u.post(`/api/bounties/${b.id}/deposits`, { chain: "bitcoin", txRef: TXID.toUpperCase() });
        expect(again.statusCode).toBe(409);
      } finally {
        await close();
      }
    });

    it("succeeds no matter whose wallet the signed-in caller has -- neither a Solana nor an Ethereum account's address has anything to do with the tx", async () => {
      const stub = new FakeProvider("solana");
      const second = "cd".repeat(32);
      const { app, close } = await makeBountyApp(depositFetch({ btcTx: btcTx() }), stub, stub);
      try {
        // A Solana account whose own address is nowhere in the BTC tx -- the ETH/SOL equivalent of
        // this is a 403 ("wasn't sent from your connected wallet"), see the Solana test above.
        const solUser = await signup(app, "btc-unrelated-solana-account");
        const b = (await solUser.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
        const viaSol = await solUser.post(`/api/bounties/${b.id}/deposits`, { chain: "bitcoin", txRef: TXID });
        expect(viaSol.statusCode).toBe(201);
        expect(viaSol.json().fromAddress).toBe(SENDER);

        // Same for an Ethereum account.
        const ethUser = await signupEthereum(app, new Wallet("0x" + "9".repeat(64)));
        const viaEth = await ethUser.post(`/api/bounties/${b.id}/deposits`, { chain: "bitcoin", txRef: second });
        expect(viaEth.statusCode).toBe(201);
      } finally {
        await close();
      }
    });

    it("an unconfirmed (still in the mempool) tx is rejected with a retry-later message, and nothing is recorded", async () => {
      const stub = new FakeProvider("solana");
      const { app, close } = await makeBountyApp(depositFetch({ btcTx: btcTx({ confirmed: false }) }), stub, stub);
      try {
        const u = await signup(app, "btc-unconfirmed");
        const b = (await u.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
        const r = await u.post(`/api/bounties/${b.id}/deposits`, { chain: "bitcoin", txRef: TXID });
        expect(r.statusCode).toBe(400);
        expect(r.json().error.message).toMatch(/isn't confirmed in a block yet/i);
        expect((await u.get(`/api/bounties/${b.id}`)).json().deposits).toEqual([]);
      } finally {
        await close();
      }
    });

    it("a malformed txid is rejected without ever reaching the explorer", async () => {
      const stub = new FakeProvider("solana");
      let explorerCalls = 0;
      const inner = depositFetch({ btcTx: btcTx() });
      const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
        if (String(input).includes("/api/tx/")) explorerCalls++;
        return inner(input, init);
      }) as typeof fetch;
      const { app, close } = await makeBountyApp(fetchImpl, stub, stub);
      try {
        const u = await signup(app, "btc-malformed");
        const b = (await u.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
        for (const txRef of ["not-a-txid", "ab".repeat(31), "zz".repeat(32), `0x${"ab".repeat(32)}`]) {
          const r = await u.post(`/api/bounties/${b.id}/deposits`, { chain: "bitcoin", txRef });
          expect(r.statusCode).toBe(400);
          expect(r.json().error.message).toMatch(/real Bitcoin transaction ID/i);
        }
        expect(explorerCalls).toBe(0);
      } finally {
        await close();
      }
    });

    it("a confirmed tx that doesn't pay the configured wallet is rejected, as is a txid the explorer doesn't know", async () => {
      const stub = new FakeProvider("solana");
      const elsewhere = btcTx({ vout: [{ scriptpubkey_address: SENDER, value: 1_000_000 }, { value: 0 } /* OP_RETURN: no address */] });
      const { app, close } = await makeBountyApp(depositFetch({ btcTx: elsewhere }), stub, stub);
      try {
        const u = await signup(app, "btc-wrong-wallet");
        const b = (await u.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
        const r = await u.post(`/api/bounties/${b.id}/deposits`, { chain: "bitcoin", txRef: TXID });
        expect(r.statusCode).toBe(400);
        expect(r.json().error.message).toMatch(/doesn't pay the configured deposit wallet/i);
      } finally {
        await close();
      }

      const missing = await makeBountyApp(depositFetch({}), stub, stub);
      try {
        const u = await signup(missing.app, "btc-unknown-txid");
        const b = (await u.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
        const r = await u.post(`/api/bounties/${b.id}/deposits`, { chain: "bitcoin", txRef: TXID });
        expect(r.statusCode).toBe(400);
        expect(r.json().error.message).toMatch(/wasn't found/i);
      } finally {
        await missing.close();
      }
    });

    it("is refused when no Bitcoin wallet is configured, and the wallets endpoint only lists what is", async () => {
      const stub = new FakeProvider("solana");
      const { app, close } = await makeBountyApp(depositFetch({ btcTx: btcTx() }), stub, stub, { depositWallets: { solana: SOL_WALLET } });
      try {
        expect((await new Client(app).get("/api/bounties/wallets")).json()).toEqual({ solana: SOL_WALLET });
        const u = await signup(app, "btc-not-configured");
        const b = (await u.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
        const r = await u.post(`/api/bounties/${b.id}/deposits`, { chain: "bitcoin", txRef: TXID });
        expect(r.statusCode).toBe(400);
        expect(r.json().error.message).toMatch(/no bitcoin deposit wallet/i);
      } finally {
        await close();
      }
    });
  });

  describe("Solana deposit sender = the real transfer authority, not the fee payer", () => {
    const SIG = "A".repeat(64);
    const SYSTEM = "11111111111111111111111111111111";
    const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    // A real-shaped wallet for the deposit side, distinct from the System Program id: in a native
    // transfer the System Program is itself in accountKeys, which would otherwise collide.
    const WALLET = testWallet("attribution-deposit-wallet").address;
    const relayer = testWallet("attribution-relayer").address;
    const payer = testWallet("attribution-real-payer").address;
    const verify = (solTx: unknown) => verifySolanaDeposit(new HttpClient("test", 1, depositFetch({ solTx })), "https://rpc.test", SIG, WALLET, DEFAULT_ALLOWED_TOKENS_SOLANA, budgetMs(2000));

    /** A sponsored native SOL transfer: the relayer pays the fee (accountKeys[0]), `payer` signs the transfer. */
    const relayedNative = (instructions: unknown[] = [{ program: "system", programId: SYSTEM, parsed: { type: "transfer", info: { source: payer, destination: WALLET, lamports: 1_000_000_000 } } }]) => ({
      transaction: { message: { accountKeys: [relayer, payer, WALLET, SYSTEM], instructions } },
      meta: { err: null, preBalances: [10_000_000, 5_000_000_000, 1_000_000_000, 1], postBalances: [9_995_000, 4_000_000_000, 2_000_000_000, 1] },
    });

    /** A sponsored USDC transfer made via CPI (inner instruction), next to an unrelated transfer to someone else's account. */
    const relayedToken = (info: Record<string, unknown>, type = "transferChecked") => {
      const payerAta = testWallet("attribution-payer-ata").address;
      const walletAta = testWallet("attribution-wallet-ata").address;
      const otherAta = testWallet("attribution-other-ata").address;
      return {
        transaction: { message: { accountKeys: [relayer, payerAta, walletAta, otherAta, USDC, TOKEN], instructions: [{ programId: "SomeRelayerProgram1111111111111111111111111" }] } },
        meta: {
          err: null,
          preBalances: [10_000_000, 2_039_280, 2_039_280, 2_039_280, 1, 1],
          postBalances: [9_995_000, 2_039_280, 2_039_280, 2_039_280, 1, 1],
          preTokenBalances: [{ accountIndex: 2, mint: USDC, owner: WALLET, uiTokenAmount: { amount: "1000000", decimals: 6 } }],
          postTokenBalances: [{ accountIndex: 2, mint: USDC, owner: WALLET, uiTokenAmount: { amount: "8500000", decimals: 6 } }],
          innerInstructions: [
            {
              instructions: [
                // Unrelated: pays a different account, signed by a different authority -- must not be picked.
                { program: "spl-token", programId: TOKEN, parsed: { type: "transfer", info: { source: payerAta, destination: otherAta, amount: "1", authority: relayer } } },
                { program: "spl-token", programId: TOKEN, parsed: { type, info: { source: payerAta, destination: walletAta, mint: USDC, ...info } } },
              ],
            },
          ],
        },
      };
    };

    it("native SOL: attributes the System transfer's source, not accountKeys[0]", async () => {
      const r = await verify(relayedNative());
      expect(r).toMatchObject({ ok: true, deposit: { asset: "native", amount: "1", fromAddress: payer } });
    });

    it("SPL transferChecked via CPI: attributes the authority of the transfer into the wallet's own token account", async () => {
      const r = await verify(relayedToken({ authority: payer, tokenAmount: { amount: "7500000", decimals: 6 } }));
      expect(r).toMatchObject({ ok: true, deposit: { asset: { contract: USDC }, amount: "7.5", fromAddress: payer } });
    });

    it("SPL transfer signed by a multisig: attributes the multisigAuthority", async () => {
      const multisig = testWallet("attribution-multisig").address;
      const r = await verify(relayedToken({ multisigAuthority: multisig, signers: [payer], amount: "7500000" }, "transfer"));
      expect(r).toMatchObject({ ok: true, deposit: { fromAddress: multisig } });
    });

    it("falls back to the fee payer (never fails the deposit) when no transfer instruction can be attributed", async () => {
      const r = await verify(relayedNative([]));
      expect(r).toMatchObject({ ok: true, deposit: { amount: "1", fromAddress: relayer } });
    });

    it("through the route: the real signer can record the relayed deposit; the relayer who only paid the fee can't", async () => {
      const stub = new FakeProvider("solana");
      const signer = testWallet("attribution-route-signer");
      const feePayer = testWallet("attribution-route-relayer");
      const solTx = {
        transaction: {
          message: {
            accountKeys: [feePayer.address, signer.address, SOL_WALLET],
            instructions: [{ program: "system", programId: SYSTEM, parsed: { type: "transfer", info: { source: signer.address, destination: SOL_WALLET, lamports: 1_000_000_000 } } }],
          },
        },
        meta: { err: null, preBalances: [10_000_000, 5_000_000_000, 1_000_000_000], postBalances: [9_995_000, 4_000_000_000, 2_000_000_000] },
      };
      const { app, close } = await makeBountyApp(depositFetch({ solTx }), stub, stub);
      try {
        const relayerClient = await signup(app, "attribution-route-relayer");
        const b = (await relayerClient.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
        const byRelayer = await relayerClient.post(`/api/bounties/${b.id}/deposits`, { chain: "solana", txRef: SIG });
        expect(byRelayer.statusCode).toBe(403); // before this fix, the fee payer was "the sender" and this was accepted

        const signerClient = await signup(app, "attribution-route-signer");
        const bySigner = await signerClient.post(`/api/bounties/${b.id}/deposits`, { chain: "solana", txRef: SIG });
        expect(bySigner.statusCode).toBe(201);
        expect(bySigner.json()).toMatchObject({ fromAddress: signer.address, amount: "1" });
      } finally {
        await close();
      }
    });
  });
});
