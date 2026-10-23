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

const BNB_WALLET = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const BNB_RPC = "https://bsc-rpc.test";
const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955";

/** An EVM JSON-RPC stand-in (the BNB one is reached at BNB_RPC): answers the three calls
 *  verifyEvmDepositViaRpc makes, plus eth_chainId (0x38 = 56, BNB Smart Chain) so a test can tell
 *  which chain's endpoint it is. Every call is logged for asserting where verification went. */
type EvmRpcMock = { tx: unknown; receipt: unknown; decimals?: number; chainId?: string; calls?: string[] };

/** Mocks the deposit-verification upstreams: Solana's getParsedTransaction RPC, Blockscout's
 *  tx/token-transfer REST endpoints, an Esplora explorer's `/api/tx/:txid` (404 when `btcTx` is
 *  unset, the same as Blockstream.info answers for a txid it doesn't know), and BNB's EVM RPC. */
function depositFetch(opts: { solTx?: unknown; bsTx?: unknown; bsTransfers?: unknown; btcTx?: unknown; bnbRpc?: EvmRpcMock }): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(BNB_RPC)) {
      const { method, params } = JSON.parse(String(init!.body)) as { method: string; params: unknown[] };
      const m = opts.bnbRpc;
      m?.calls?.push(method);
      const result =
        method === "eth_chainId" ? (m?.chainId ?? "0x38")
        : method === "eth_getTransactionByHash" ? (m?.tx ?? null)
        : method === "eth_getTransactionReceipt" ? (m?.receipt ?? null)
        : method === "eth_call" && (params[0] as { data: string }).data === "0x313ce567" ? `0x${(m?.decimals ?? 18).toString(16).padStart(64, "0")}`
        : null;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200, headers: { "content-type": "application/json" } });
    }
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
  const config = { ...loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), dbPath: ":memory:", bnbRpcUrl: BNB_RPC, depositWallets: { solana: SOL_WALLET, ethereum: ETH_WALLET, bnb: BNB_WALLET, bitcoin: BTC_WALLET }, ...over };
  const db = openDb(":memory:");
  const { app } = await buildApp(config, {
    db,
    providers: { ethereum: eth, solana: sol, bnb: new FakeProvider("bnb") },
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
  describe("BNB Chain deposits (EVM RPC verification, Ethereum sign-in owns the sender)", () => {
    const HASH = `0x${"d".repeat(64)}`;
    const wallet = new Wallet("0x" + "8".repeat(64));
    const sender = wallet.address;
    const topic = (addr: string) => `0x${"0".repeat(24)}${addr.slice(2).toLowerCase()}`;
    const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const nativeTx = { to: BNB_WALLET.toLowerCase(), from: sender.toLowerCase(), value: "0x1bc16d674ec80000", blockNumber: "0x7b5928e" }; // 2 BNB
    const tokenTx = (contract: string) => ({
      tx: { to: contract.toLowerCase(), from: sender.toLowerCase(), value: "0x0", blockNumber: "0x7b5928e" },
      receipt: { status: "0x1", logs: [{ address: contract.toLowerCase(), topics: [TRANSFER, topic(sender), topic(BNB_WALLET)], data: `0x${(55n * 10n ** 17n).toString(16).padStart(64, "0")}` }] }, // 5.5 at 18 decimals
    });

    it("native BNB: verified against BNB's own RPC only, recorded on chain bnb by the Ethereum-signed-in sender", async () => {
      const calls: string[] = [];
      const { app, close } = await makeBountyApp(depositFetch({ bnbRpc: { tx: nativeTx, receipt: { status: "0x1", logs: [] }, calls } }), new FakeProvider("ethereum"), new FakeProvider("solana"));
      try {
        const u = await signupEthereum(app, wallet);
        const b = (await u.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
        const r = await u.post(`/api/bounties/${b.id}/deposits`, { chain: "bnb", txRef: HASH });
        expect(r.statusCode).toBe(201);
        expect(r.json()).toMatchObject({ chain: "bnb", asset: "native", amount: "2", toWallet: BNB_WALLET, txRef: HASH });
        expect(calls.sort()).toEqual(["eth_getTransactionByHash", "eth_getTransactionReceipt"]);
        // Same hash, other letter-casing: still the same real transaction.
        expect((await u.post(`/api/bounties/${b.id}/deposits`, { chain: "bnb", txRef: HASH.toUpperCase().replace("0X", "0x") })).statusCode).toBe(409);
        expect((await new Client(app).get("/api/bounties/wallets")).json()).toMatchObject({ bnb: BNB_WALLET });
      } finally {
        await close();
      }
    });

    it("BEP-20 USDT: read off the receipt's Transfer log with the token's real decimals()", async () => {
      const { app, close } = await makeBountyApp(depositFetch({ bnbRpc: { ...tokenTx(USDT_BSC), decimals: 18 } }), new FakeProvider("ethereum"), new FakeProvider("solana"));
      try {
        const u = await signupEthereum(app, wallet);
        const b = (await u.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
        const r = await u.post(`/api/bounties/${b.id}/deposits`, { chain: "bnb", txRef: HASH });
        expect(r.statusCode).toBe(201);
        expect(r.json()).toMatchObject({ chain: "bnb", asset: { contract: USDT_BSC.toLowerCase() }, amount: "5.5", fromAddress: sender.toLowerCase() });
      } finally {
        await close();
      }
    });

    it("the allowlists are per chain: Ethereum's USDC contract address counts for nothing on BNB", async () => {
      const ETH_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
      const { app, close } = await makeBountyApp(depositFetch({ bnbRpc: tokenTx(ETH_USDC) }), new FakeProvider("ethereum"), new FakeProvider("solana"));
      try {
        const u = await signupEthereum(app, wallet);
        const b = (await u.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
        const r = await u.post(`/api/bounties/${b.id}/deposits`, { chain: "bnb", txRef: HASH });
        expect(r.statusCode).toBe(400);
        expect(r.json().error.message).toMatch(/not in an asset this server tracks/);
      } finally {
        await close();
      }
    });

    it("sender check: a Solana sign-in, or a different Ethereum wallet, can't record someone's BNB payment", async () => {
      const { app, close } = await makeBountyApp(depositFetch({ bnbRpc: { tx: nativeTx, receipt: { status: "0x1", logs: [] } } }), new FakeProvider("ethereum"), new FakeProvider("solana"));
      try {
        const sol = await signup(app, "bnb-sol-user");
        const b = (await sol.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
        const r1 = await sol.post(`/api/bounties/${b.id}/deposits`, { chain: "bnb", txRef: HASH });
        expect(r1.statusCode).toBe(403);
        const other = await signupEthereum(app, new Wallet("0x" + "9".repeat(64)));
        const r2 = await other.post(`/api/bounties/${b.id}/deposits`, { chain: "bnb", txRef: HASH });
        expect(r2.statusCode).toBe(403);
        expect(r2.json().error.message).toMatch(/wasn't sent from your connected wallet/);
      } finally {
        await close();
      }
    });

    it("a failed receipt, a malformed hash and a missing BNB wallet are each refused clearly", async () => {
      const { app, close } = await makeBountyApp(depositFetch({ bnbRpc: { tx: nativeTx, receipt: { status: "0x0", logs: [] } } }), new FakeProvider("ethereum"), new FakeProvider("solana"));
      try {
        const u = await signupEthereum(app, wallet);
        const b = (await u.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
        expect((await u.post(`/api/bounties/${b.id}/deposits`, { chain: "bnb", txRef: HASH })).json().error.message).toMatch(/didn't succeed on-chain/);
        expect((await u.post(`/api/bounties/${b.id}/deposits`, { chain: "bnb", txRef: "0x1234" })).json().error.message).toMatch(/real BNB Chain transaction hash/);
      } finally {
        await close();
      }
      const none = await makeBountyApp(depositFetch({}), new FakeProvider("ethereum"), new FakeProvider("solana"), { depositWallets: { ethereum: ETH_WALLET } });
      try {
        expect((await new Client(none.app).get("/api/bounties/wallets")).json()).toEqual({ ethereum: ETH_WALLET });
        const u = await signupEthereum(none.app, wallet);
        const b = (await u.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
        const r = await u.post(`/api/bounties/${b.id}/deposits`, { chain: "bnb", txRef: HASH });
        expect(r.statusCode).toBe(400);
        expect(r.json().error.message).toMatch(/no bnb deposit wallet/i);
      } finally {
        await none.close();
      }
    });

    it("config: DEPOSIT_WALLET_BNB and BNB's own allowlist (BEP-20 USDC/USDT by default, extendable)", () => {
      const c = loadConfig({ NODE_ENV: "test", DEPOSIT_WALLET_BNB: ` ${BNB_WALLET} `, DEPOSIT_ALLOWED_TOKENS_BNB: "0x1111111111111111111111111111111111111111" } as NodeJS.ProcessEnv);
      expect(c.depositWallets.bnb).toBe(BNB_WALLET);
      expect([...c.depositAllowedTokens.bnb].sort()).toEqual(["0x1111111111111111111111111111111111111111", USDT_BSC, "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"].sort());
      expect(c.depositAllowedTokens.ethereum.has(USDT_BSC)).toBe(false);
    });
  });

  describe("Robinhood Chain deposits (the same EVM verifier, on the chain's own public RPC)", () => {
    const RH_RPC = "https://rpc.mainnet.chain.robinhood.com"; // config's zero-config default
    const RH_WALLET = "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB";
    const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"; // the real USDG contract on Robinhood Chain
    const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const topic = (addr: string) => `0x${"0".repeat(24)}${addr.slice(2).toLowerCase()}`;
    const amountData = (raw: bigint) => `0x${raw.toString(16).padStart(64, "0")}`;
    const wallet = new Wallet("0x" + "7".repeat(64));
    const HASH = `0x${"9".repeat(64)}`;

    type RpcTx = { to: string | null; from: string; value: string; blockNumber: string | null };
    type RpcReceipt = { status: string; logs: { address: string; topics: string[]; data: string }[] };
    /** JSON-RPC at Robinhood Chain's RPC only. Anything else -- Ethereum's Blockscout, an Ethereum RPC,
     *  Robinhood Chain's own Blockscout -- answers 418, so a request routed to the wrong place can't
     *  quietly verify. */
    function rhRpcFetch(opts: { tx?: RpcTx | null; receipt?: RpcReceipt | null; decimals?: number }, seen: string[] = []): typeof fetch {
      return (async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url !== RH_RPC || init?.method !== "POST") return new Response("wrong endpoint", { status: 418 });
        const { method } = JSON.parse(String(init.body)) as { method: string };
        seen.push(method);
        const result =
          method === "eth_getTransactionByHash" ? (opts.tx ?? null) : method === "eth_getTransactionReceipt" ? (opts.receipt ?? null) : method === "eth_call" ? amountData(BigInt(opts.decimals ?? 18)) : null;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
    }
    const nativeTx = (from: string): RpcTx => ({ to: RH_WALLET.toLowerCase(), from: from.toLowerCase(), value: "0x3782dace9d900000" /* 4 ETH */, blockNumber: "0x89" });
    const ok: RpcReceipt = { status: "0x1", logs: [] };
    const tokenReceipt = (token: string, from: string, raw: bigint): RpcReceipt => ({ status: "0x1", logs: [{ address: token.toLowerCase(), topics: [TRANSFER_TOPIC, topic(from), topic(RH_WALLET)], data: amountData(raw) }] });
    const tokenTx = (from: string, token: string): RpcTx => ({ to: token.toLowerCase(), from: from.toLowerCase(), value: "0x0", blockNumber: "0x89" });

    const app = (fetchImpl: typeof fetch, over: Partial<Config> = {}) =>
      makeBountyApp(fetchImpl, new FakeProvider("ethereum"), new FakeProvider("solana"), { depositWallets: { ethereum: ETH_WALLET, robinhood: RH_WALLET }, ...over });

    it("records native ETH on Robinhood Chain for the Ethereum-signed-in sender, as chain robinhood, and lists the wallet", async () => {
      const seen: string[] = [];
      const { app: a, close } = await app(rhRpcFetch({ tx: nativeTx(wallet.address), receipt: ok }, seen));
      try {
        expect((await new Client(a).get("/api/bounties/wallets")).json()).toEqual({ ethereum: ETH_WALLET, robinhood: RH_WALLET });
        const u = await signupEthereum(a, wallet);
        const b = (await u.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
        const r = await u.post(`/api/bounties/${b.id}/deposits`, { chain: "robinhood", txRef: HASH.toUpperCase().replace("0X", "0x") });
        expect(r.statusCode).toBe(201);
        expect(r.json()).toMatchObject({ chain: "robinhood", asset: "native", amount: "4", txRef: HASH, toWallet: RH_WALLET });
        expect(seen).toEqual(expect.arrayContaining(["eth_getTransactionByHash", "eth_getTransactionReceipt"]));
        // The same payment again (any casing) is a replay; the bounty shows it under Robinhood Chain.
        expect((await u.post(`/api/bounties/${b.id}/deposits`, { chain: "robinhood", txRef: HASH })).statusCode).toBe(409);
        expect((await u.get(`/api/bounties/${b.id}`)).json().deposits).toEqual([expect.objectContaining({ chain: "robinhood", asset: "native" })]);
      } finally {
        await close();
      }
    });

    it("records USDG at its real on-chain decimals (6, read via decimals())", async () => {
      const { app: a, close } = await app(rhRpcFetch({ tx: tokenTx(wallet.address, USDG), receipt: tokenReceipt(USDG, wallet.address, 25_000_000n), decimals: 6 }));
      try {
        const u = await signupEthereum(a, wallet);
        const b = (await u.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
        const r = await u.post(`/api/bounties/${b.id}/deposits`, { chain: "robinhood", txRef: HASH });
        expect(r.statusCode).toBe(201);
        expect(r.json()).toMatchObject({ chain: "robinhood", asset: { contract: USDG.toLowerCase() }, amount: "25" });
      } finally {
        await close();
      }
    });

    it("Ethereum's allowlist doesn't carry over: a token at mainnet USDC's address is not a tracked asset on Robinhood Chain", async () => {
      const { app: a, close } = await app(rhRpcFetch({ tx: tokenTx(wallet.address, MAINNET_USDC), receipt: tokenReceipt(MAINNET_USDC, wallet.address, 5_000_000n), decimals: 6 }));
      try {
        const u = await signupEthereum(a, wallet);
        const b = (await u.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
        const r = await u.post(`/api/bounties/${b.id}/deposits`, { chain: "robinhood", txRef: HASH });
        expect(r.statusCode).toBe(400);
        expect(r.json().error.message).toBe("That transaction pays the right wallet, but not in an asset this server tracks for Robinhood Chain deposits (native ETH or USDG)");
      } finally {
        await close();
      }
    });

    it("the sender must be the caller's own signed-in wallet: another Ethereum account and a Solana account are both refused", async () => {
      const { app: a, close } = await app(rhRpcFetch({ tx: nativeTx(wallet.address), receipt: ok }));
      try {
        const otherEth = await signupEthereum(a, new Wallet("0x" + "8".repeat(64)));
        const b = (await otherEth.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
        const r1 = await otherEth.post(`/api/bounties/${b.id}/deposits`, { chain: "robinhood", txRef: HASH });
        expect(r1.statusCode).toBe(403);
        const sol = await signup(a, "rh-solana-account");
        const r2 = await sol.post(`/api/bounties/${b.id}/deposits`, { chain: "robinhood", txRef: HASH });
        expect(r2.statusCode).toBe(403);
        expect(r2.json().error.message).toMatch(/wasn't sent from your connected wallet/i);
        expect((await otherEth.get(`/api/bounties/${b.id}`)).json().deposits).toEqual([]);
      } finally {
        await close();
      }
    });

    it("a reverted tx, an unknown hash and a malformed hash are each refused with their own message", async () => {
      const reverted = await app(rhRpcFetch({ tx: nativeTx(wallet.address), receipt: { status: "0x0", logs: [] } }));
      try {
        const u = await signupEthereum(reverted.app, wallet);
        const b = (await u.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
        expect((await u.post(`/api/bounties/${b.id}/deposits`, { chain: "robinhood", txRef: HASH })).json().error.message).toBe("That transaction didn't succeed on-chain");
        const bad = await u.post(`/api/bounties/${b.id}/deposits`, { chain: "robinhood", txRef: "0x1234" });
        expect(bad.statusCode).toBe(400);
        expect(bad.json().error.message).toBe("That doesn't look like a real Robinhood Chain transaction hash");
      } finally {
        await reverted.close();
      }
      const missing = await app(rhRpcFetch({ tx: null, receipt: null }));
      try {
        const u = await signupEthereum(missing.app, wallet);
        const b = (await u.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
        expect((await u.post(`/api/bounties/${b.id}/deposits`, { chain: "robinhood", txRef: HASH })).json().error.message).toBe("That transaction wasn't found");
      } finally {
        await missing.close();
      }
    });

    it("is refused when no Robinhood Chain wallet is configured, even with an Ethereum one set", async () => {
      const { app: a, close } = await app(rhRpcFetch({ tx: nativeTx(wallet.address), receipt: ok }), { depositWallets: { ethereum: ETH_WALLET } });
      try {
        const u = await signupEthereum(a, wallet);
        const b = (await u.post("/api/bounties", { title: "T", description: "D", reward: "R" })).json();
        const r = await u.post(`/api/bounties/${b.id}/deposits`, { chain: "robinhood", txRef: HASH });
        expect(r.statusCode).toBe(400);
        expect(r.json().error.message).toMatch(/no robinhood deposit wallet/i);
      } finally {
        await close();
      }
    });
  });
});
