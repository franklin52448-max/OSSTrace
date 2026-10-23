import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addressNodeId } from "@osstrace/contract";
import { EtherscanBnbProvider, nextBnbCursor, normalizeBnbInternal, normalizeBnbTokenTransfers, normalizeBnbTransactions } from "../src/chain/bnb.ts";
import { TransferStore } from "../src/chain/store.ts";
import { loadConfig } from "../src/config.ts";
import { ProviderError } from "../src/lib/errors.ts";
import { budgetMs } from "../src/lib/http.ts";
import { ETH_A, ETH_B, ethTransfer, makeApp, signup, type TestApp } from "./helpers.ts";

// Etherscan V2 rows have the same shape on every `chainid`. These follow a real chainid=1 response
// recorded 2026-10-23 field for field (the free tier refuses chainid=56, so there is no free real BSC
// recording to take), with BNB-side values: real BEP-20 USDT, lowercase addresses as Etherscan sends.
const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955";
const A = ETH_A.toLowerCase();
const B = ETH_B.toLowerCase();
const h = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const txRow = (n: number, block: number, o: Record<string, string> = {}) => ({
  blockNumber: String(block),
  blockHash: h(9000 + n),
  timeStamp: String(1792675727 - (60_000_000 - block)),
  hash: h(n),
  nonce: "10",
  transactionIndex: "149",
  from: B,
  to: A,
  value: "1500000000000000000",
  gas: "21926",
  gasPrice: "333736561",
  input: "0x",
  methodId: "0x",
  functionName: "",
  contractAddress: "",
  cumulativeGasUsed: "22032083",
  txreceipt_status: "1",
  gasUsed: "21000",
  confirmations: "7550",
  isError: "0",
  ...o,
});
const tokenRow = (n: number, block: number, o: Record<string, string> = {}) => ({
  blockNumber: String(block),
  timeStamp: "1792762187",
  hash: h(n),
  nonce: "61",
  blockHash: h(8000 + n),
  from: B,
  contractAddress: USDT_BSC.toLowerCase(),
  to: A,
  value: "2500000000000000000",
  tokenName: "Tether USD",
  tokenSymbol: "USDT",
  tokenDecimal: "18",
  transactionIndex: "254",
  gas: "45528",
  gasPrice: "235560691",
  gasUsed: "45148",
  cumulativeGasUsed: "29574535",
  input: "deprecated",
  methodId: "0xa9059cbb",
  functionName: "transfer(address _to, uint256 _value)",
  confirmations: "375",
  ...o,
});
const ok = (result: unknown) => new Response(JSON.stringify({ status: "1", message: "OK", result }), { status: 200 });
const notok = (result: string) => new Response(JSON.stringify({ status: "0", message: "NOTOK", result }), { status: 200 });
const FREE_TIER = "Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage. https://etherscan.io/apis";
const KEY = "not-a-real-key";

describe("BNB (Etherscan V2) normalisation", () => {
  it("txlist: successful native value only, EIP-55 addresses, id <hash>_t0, priced as binancecoin", () => {
    const out = normalizeBnbTransactions([
      txRow(1, 100),
      txRow(2, 100, { isError: "1" }), // reverted
      txRow(3, 100, { txreceipt_status: "0" }), // failed receipt
      txRow(4, 100, { value: "0" }), // a contract call that moved nothing
      txRow(5, 100, { to: "", contractAddress: A }), // contract creation with value
    ] as never[]);
    expect(out.map((t) => t.txHash)).toEqual([h(1), h(5)]);
    expect(out[0]).toMatchObject({ chain: "bnb", id: `${h(1)}_t0`, from: ETH_B, to: ETH_A, tokenId: "native", tokenSymbol: "BNB", tokenDecimals: 18, amountRaw: "1500000000000000000", priceCoin: "coingecko:binancecoin", blockNumber: 100 });
    expect(out[1]!.to).toBe(ETH_A);
  });

  it("txlistinternal: id from Etherscan's own traceId, failed calls dropped", () => {
    const row = { blockNumber: "200", transactionIndex: "53", timeStamp: "1792587563", hash: h(7), from: B, to: A, value: "1000000000000", contractAddress: "", input: "", type: "call", gas: "10897", gasUsed: "62", traceId: "0_1_1_1", isError: "0", errCode: "" };
    const out = normalizeBnbInternal([row, { ...row, traceId: "0_2", isError: "1" }] as never[]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: `${h(7)}_i0_1_1_1`, tokenSymbol: "BNB", from: ETH_B, to: ETH_A });
  });

  it("tokentx: BEP-20 priced under DefiLlama's bsc: prefix; ids stable across pages, duplicates kept apart", () => {
    const rows = [tokenRow(1, 300), tokenRow(1, 300), tokenRow(1, 300, { value: "7" }), tokenRow(2, 299, { tokenDecimal: "99999" })];
    const out = normalizeBnbTokenTransfers(rows as never[], "erc20");
    expect(out[0]).toMatchObject({ chain: "bnb", tokenId: USDT_BSC, tokenStandard: "erc20", tokenDecimals: 18, tokenSymbol: "USDT", priceCoin: `bsc:${USDT_BSC}` });
    // Two identical transfers in one tx are two transfers, not one.
    expect(out[0]!.id).not.toBe(out[1]!.id);
    expect(out[1]!.id).toBe(`${out[0]!.id}_1`);
    expect(new Set(out.map((t) => t.id)).size).toBe(4);
    // The same rows seen again (a page re-fetching a block) get the same ids: no double counting.
    expect(normalizeBnbTokenTransfers(rows as never[], "erc20").map((t) => t.id)).toEqual(out.map((t) => t.id));
    // Field-derived, not position-derived: the id survives the row arriving in a different page.
    expect(normalizeBnbTokenTransfers([rows[2]!] as never[], "erc20")[0]!.id).toBe(out[2]!.id);
    for (const t of out) expect(t.id.length).toBeLessThanOrEqual(200);
    // A decimals value no real token can have is unknown, never something to scale by.
    expect(out[3]!.tokenDecimals).toBeNull();
  });

  it("tokennfttx / token1155tx: one unit per NFT, 1155 by tokenValue, never priced", () => {
    const nft = normalizeBnbTokenTransfers([{ ...tokenRow(3, 10), tokenID: "1617", tokenDecimal: "0", tokenName: "Pancake Squad", tokenSymbol: "PS" }] as never[], "erc721");
    expect(nft[0]).toMatchObject({ tokenStandard: "erc721", amountRaw: "1", tokenDecimals: 0, priceCoin: null, tokenName: "Pancake Squad #1617" });
    const multi = normalizeBnbTokenTransfers([{ ...tokenRow(4, 10), tokenID: "621", tokenValue: "10001", value: undefined as never }] as never[], "erc1155");
    expect(multi[0]).toMatchObject({ tokenStandard: "erc1155", amountRaw: "10001", priceCoin: null });
  });

  it("transfer store prices bnb under the right DefiLlama keys", () => {
    expect(TransferStore.coinFor({ chain: "bnb", token_id: "native", token_standard: "native" })).toBe("coingecko:binancecoin");
    expect(TransferStore.coinFor({ chain: "bnb", token_id: USDT_BSC, token_standard: "erc20" })).toBe(`bsc:${USDT_BSC}`);
    expect(TransferStore.coinFor({ chain: "ethereum", token_id: "native", token_standard: "native" })).toBe("coingecko:ethereum");
  });
});

describe("BNB paging cursor", () => {
  it("moves endblock down to the oldest block of a multi-block page", () => {
    expect(nextBnbCursor({ e: null, p: 1 }, 90, 100)).toEqual({ e: 90, p: 1 });
    expect(nextBnbCursor({ e: 90, p: 1 }, 80, 90)).toEqual({ e: 80, p: 1 });
  });
  it("pages within a block that holds a whole page, and skips one too big for Etherscan's window", () => {
    expect(nextBnbCursor({ e: null, p: 1 }, 100, 100)).toEqual({ e: 100, p: 2 });
    expect(nextBnbCursor({ e: 100, p: 2 }, 100, 100)).toEqual({ e: 100, p: 3 });
    expect(nextBnbCursor({ e: 120, p: 3 }, 100, 100)).toEqual({ e: 100, p: 1 });
    expect(nextBnbCursor({ e: 100, p: 10 }, 100, 100)).toEqual({ skip: 100 });
  });
});

describe("EtherscanBnbProvider", () => {
  const make = (fetchImpl: typeof fetch, apiKey: string | null = KEY) =>
    new EtherscanBnbProvider({ apiUrl: "https://etherscan.test/v2/api", apiKey, rpcUrl: "https://bsc-rpc.test" }, fetchImpl);

  it("asks Etherscan for chainid=56, newest first, and pages a full page by endblock", async () => {
    const urls: URL[] = [];
    const fetchImpl = (async (u: string) => {
      const url = new URL(String(u));
      urls.push(url);
      // A full 1000-row page spanning blocks 1000..501, then a short one.
      if (urls.length === 1) return ok(Array.from({ length: 1000 }, (_, i) => txRow(i + 1, 1000 - Math.floor(i / 2))));
      return ok([txRow(5000, 500)]);
    }) as unknown as typeof fetch;
    const p = make(fetchImpl);
    const first = await p.fetchStreamPage(A, "transactions", null, budgetMs(5000));
    const q = urls[0]!.searchParams;
    expect(urls[0]!.origin + urls[0]!.pathname).toBe("https://etherscan.test/v2/api");
    expect(Object.fromEntries(q)).toMatchObject({ chainid: "56", module: "account", action: "txlist", address: ETH_A, sort: "desc", page: "1", offset: "1000", apikey: KEY });
    expect(q.has("endblock")).toBe(false); // BSC is past block 99,999,999: never cap the head with a fixed number
    expect(first.transfers).toHaveLength(1000);
    expect(first.nextCursor).toBe(JSON.stringify({ e: 501, p: 1 }));
    const second = await p.fetchStreamPage(A, "transactions", first.nextCursor, budgetMs(5000));
    expect(urls[1]!.searchParams.get("endblock")).toBe("501");
    expect(second.nextCursor).toBeNull();
  });

  it("maps each stream to its Etherscan action", async () => {
    const actions: string[] = [];
    const fetchImpl = (async (u: string) => {
      actions.push(new URL(String(u)).searchParams.get("action")!);
      return new Response(JSON.stringify({ status: "0", message: "No transactions found", result: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = make(fetchImpl);
    for (const s of p.streams()) {
      const page = await p.fetchStreamPage(A, s, null, budgetMs(5000));
      expect(page).toMatchObject({ transfers: [], nextCursor: null, oldestTime: null });
    }
    expect(actions).toEqual(["txlist", "txlistinternal", "tokentx", "tokennfttx", "token1155tx"]);
  });

  it("surfaces Etherscan's free-tier refusal of chain 56 as a provider error, never an empty history", async () => {
    const p = make((async () => notok(FREE_TIER)) as unknown as typeof fetch);
    const err = await p.fetchStreamPage(A, "transactions", null, budgetMs(5000)).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(/plan doesn't cover chain 56/);
    expect(err.message).not.toContain(KEY);
    expect(await p.ping()).toMatchObject({ ok: false, note: expect.stringMatching(/plan doesn't cover chain 56/) });
  });

  it("with no ETHERSCAN_API_KEY it says so without making a call", async () => {
    let calls = 0;
    const p = make((async () => (calls++, ok([]))) as unknown as typeof fetch, null);
    const err = await p.fetchStreamPage(A, "token-transfers", null, budgetMs(5000)).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(/ETHERSCAN_API_KEY/);
    expect((await p.ping()).ok).toBe(false);
    expect(calls).toBe(0);
  });

  it("retries Etherscan's per-second rate limit (an HTTP 200) and never leaks the key in other errors", async () => {
    let calls = 0;
    const p = make((async () => (++calls === 1 ? notok("Max calls per sec rate limit reached (5/sec)") : ok([txRow(1, 10)]))) as unknown as typeof fetch);
    const page = await p.fetchStreamPage(A, "transactions", null, budgetMs(10_000));
    expect(calls).toBe(2);
    expect(page.transfers).toHaveLength(1);
    const bad = make((async () => notok(`Invalid API Key (#err2)|${KEY}`)) as unknown as typeof fetch);
    const err = await bad.fetchStreamPage(A, "transactions", null, budgetMs(5000)).catch((e) => e);
    expect(err.message).toMatch(/^Etherscan: Invalid API Key/);
    expect(err.message).not.toContain(KEY);
  });

  it("balances: native from eth_getBalance, BEP-20s discovered from tokentx and read live via balanceOf", async () => {
    const DEAD_TOKEN = "0x00000000000000000000000000000000000000aa";
    const EMPTY_TOKEN = "0x00000000000000000000000000000000000000bb";
    const rpcBodies: any[] = [];
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      const url = String(u);
      if (url.startsWith("https://etherscan.test")) {
        expect(new URL(url).searchParams.get("action")).toBe("tokentx");
        return ok([tokenRow(1, 10), tokenRow(2, 9), tokenRow(3, 8, { contractAddress: DEAD_TOKEN, tokenSymbol: "DEAD" }), tokenRow(4, 7, { contractAddress: EMPTY_TOKEN, tokenSymbol: "GONE" })]);
      }
      const body = JSON.parse(String(init!.body));
      rpcBodies.push(body);
      if (!Array.isArray(body)) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x16345785d8a0000" }), { status: 200 }); // 0.1 BNB
      // Answered out of order, on purpose: results must be paired by id (LESSONS.md).
      const byTo = (to: string) => body.find((r: any) => r.params[0].to.toLowerCase() === to.toLowerCase());
      return new Response(
        JSON.stringify([
          { jsonrpc: "2.0", id: byTo(EMPTY_TOKEN).id, result: "0x0000000000000000000000000000000000000000000000000000000000000000" },
          { jsonrpc: "2.0", id: byTo(DEAD_TOKEN).id, error: { code: -32000, message: "execution reverted" } },
          { jsonrpc: "2.0", id: byTo(USDT_BSC).id, result: "0x00000000000000000000000000000000000000000000000029a2241af62c0000" }, // 3e18
        ]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const out = await make(fetchImpl).fetchBalances(A, budgetMs(5000));
    expect(out).toEqual([
      { tokenId: "native", symbol: "BNB", name: "BNB", decimals: 18, amountRaw: "100000000000000000", priceCoin: "coingecko:binancecoin" },
      { tokenId: USDT_BSC, symbol: "USDT", name: "Tether USD", decimals: 18, amountRaw: "3000000000000000000", priceCoin: `bsc:${USDT_BSC}` },
    ]);
    expect(rpcBodies[0]).toMatchObject({ method: "eth_getBalance", params: [ETH_A, "latest"] });
    // One balanceOf per distinct contract, calldata = selector + the address left-padded to 32 bytes.
    expect(rpcBodies[1]).toHaveLength(3);
    expect(rpcBodies[1][0].params[0].data).toBe(`0x70a08231${"0".repeat(24)}${A.slice(2)}`);
  });

  it("balances throw (rather than show a token-less wallet) when token discovery fails", async () => {
    const fetchImpl = (async (u: string) =>
      String(u).startsWith("https://etherscan.test") ? notok(FREE_TIER) : new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), { status: 200 })) as unknown as typeof fetch;
    await expect(make(fetchImpl).fetchBalances(A, budgetMs(5000))).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("BNB config", () => {
  it("defaults to BNB Chain's public RPC, overridable; reuses ETHERSCAN_API_KEY", () => {
    const d = loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    expect(d.bnbRpcUrl).toBe("https://bsc-dataseed.bnbchain.org");
    expect(d.etherscanApiKey).toBeNull();
    expect(d.etherscanUrl).toBe("https://api.etherscan.io/v2/api");
    const c = loadConfig({ NODE_ENV: "test", BNB_RPC_URL: " https://my-bsc.example/rpc ", ETHERSCAN_API_KEY: " k " } as NodeJS.ProcessEnv);
    expect(c.bnbRpcUrl).toBe("https://my-bsc.example/rpc");
    expect(c.etherscanApiKey).toBe("k");
  });
});

describe("BNB as a first-class chain through the API", () => {
  let t: TestApp;
  beforeEach(async () => (t = await makeApp()));
  afterEach(async () => t.close());

  it("address lookup, balances, transfers and counterparties on chain bnb use the bnb provider only", async () => {
    const base = Math.floor(Date.now() / 1000) - 3600;
    t.bnb.add([ethTransfer(ETH_B, ETH_A, base, { chain: "bnb", tokenSymbol: "BNB", tokenName: "BNB", priceCoin: "coingecko:binancecoin" })]);
    t.bnb.balances = [{ tokenId: "native", symbol: "BNB", name: "BNB", decimals: 18, amountRaw: "2000000000000000000", priceCoin: "coingecko:binancecoin" }];
    const lower = ETH_A.toLowerCase();
    expect((await t.app.inject(`/api/address/bnb/${lower}`)).json()).toMatchObject({ chain: "bnb", address: ETH_A });
    const bal = (await t.app.inject(`/api/address/bnb/${ETH_A}/balances`)).json();
    expect(bal.balances[0]).toMatchObject({ symbol: "BNB", amount: "2", usd: 4000 });
    const cps = (await t.app.inject(`/api/address/bnb/${ETH_A}/counterparties?flow=in`)).json();
    expect(cps.counterparties[0]).toMatchObject({ address: { chain: "bnb", address: ETH_B }, flow: "in" });
    const tr = (await t.app.inject(`/api/transfers?base=bnb:${ETH_A}`)).json();
    expect(tr.transfers).toHaveLength(1);
    expect(tr.transfers[0]).toMatchObject({ chain: "bnb", tokenSymbol: "BNB" });
    // chain=bnb with a bare 0x base means the BNB account, not the Ethereum one.
    expect((await t.app.inject(`/api/transfers?base=${ETH_A}&chain=bnb`)).json().transfers).toHaveLength(1);
    expect(t.eth.calls).toBe(0);
    expect((await t.app.inject(`/api/address/bnb/9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM`)).statusCode).toBe(400);
    const health = (await t.app.inject("/api/health")).json();
    expect(health.chains.map((c: { id: string; name: string }) => `${c.id}:${c.name}`)).toEqual(["solana:Solana", "ethereum:Ethereum", "bnb:BNB Chain"]);
  });

  it("labels and traces accept bnb addresses, kept separate from the same address on ethereum", async () => {
    const a = await signup(t.app, "bnb-analyst");
    expect((await a.post("/api/labels", { chain: "bnb", address: ETH_A.toLowerCase(), name: "BSC hot wallet" })).statusCode).toBe(201);
    expect((await a.post("/api/labels", { chain: "ethereum", address: ETH_A, name: "ETH hot wallet" })).statusCode).toBe(201);
    expect((await a.get(`/api/address/bnb/${ETH_A}`)).json().label).toMatchObject({ name: "BSC hot wallet" });
    expect((await a.get(`/api/address/ethereum/${ETH_A}`)).json().label).toMatchObject({ name: "ETH hot wallet" });
    const imp = (await a.post("/api/labels/import", { format: "csv", data: `chain,address,name\nbnb,${ETH_B},Imported BSC\nbnb,9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM,bad`, onConflict: "update" })).json();
    expect(imp.created).toBe(1);
    expect(imp.skipped).toEqual([{ row: 3, reason: "not a valid bnb address" }]); // row 1 is the CSV header

    const tr = await a.post("/api/traces", { title: "bsc", initialChain: "bnb", initialAddress: ETH_A.toLowerCase() });
    expect(tr.statusCode).toBe(201);
    const id = tr.json().id;
    const doc = (await a.get(`/api/traces/${id}`)).json();
    expect(doc.nodes[0]).toMatchObject({ kind: "address", chain: "bnb", address: ETH_A, id: addressNodeId(id, "bnb", ETH_A) });
    // The same address on Ethereum is a different node.
    expect(addressNodeId(id, "ethereum", ETH_A)).not.toBe(doc.nodes[0].id);
  });

  it("migration 007 widens labels.chain without wiping any label's tags", async () => {
    const a = await signup(t.app, "tagger");
    const tag = (await a.post("/api/tags", { name: "cex", color: "#ff0000" })).json();
    const lab = (await a.post("/api/labels", { chain: "ethereum", address: ETH_A, name: "Hot", tagIds: [tag.id] })).json();
    // Re-run 007 against a populated table: the table rebuild must carry every label_tags row across
    // (DROP TABLE's implicit DELETE would otherwise cascade them away).
    t.ctx.db.run("DELETE FROM schema_migrations WHERE version = '007_labels_bnb_chain'");
    expect(t.ctx.db.migrate()).toEqual(["007_labels_bnb_chain"]);
    expect((await a.get(`/api/address/ethereum/${ETH_A}`)).json().tags).toEqual([{ id: tag.id, name: "cex", color: "#ff0000" }]);
    expect(t.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM label_tags WHERE label_id = ?", lab.id)!.n).toBe(1);
    expect(t.ctx.db.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(() => t.ctx.db.run("INSERT INTO labels (id, user_id, chain, address, name, created_at, updated_at) SELECT 'x', user_id, 'bitcoin', 'a', 'n', 'now', 'now' FROM labels LIMIT 1")).toThrow(/CHECK/);
  });
});
