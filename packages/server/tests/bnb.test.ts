import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addressNodeId } from "@osstrace/contract";
import { buildApp } from "../src/app.ts";
import { AlchemyProvider } from "../src/chain/alchemy.ts";
import { TransferStore } from "../src/chain/store.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { budgetMs } from "../src/lib/http.ts";
import { alchemyFetch, ETH_A, ETH_B, ethTransfer, makeApp, signup, type TestApp } from "./helpers.ts";

// BNB Smart Chain's history and balances come from AlchemyProvider (chain/alchemy.ts, tested in
// alchemy.test.ts) on BNB_RPC_URL: Etherscan V2, the earlier source, refuses chain 56 on its free tier.
const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955";

describe("BNB pricing keys", () => {
  it("transfer store prices bnb under the right DefiLlama keys", () => {
    expect(TransferStore.coinFor({ chain: "bnb", token_id: "native", token_standard: "native" })).toBe("coingecko:binancecoin");
    expect(TransferStore.coinFor({ chain: "bnb", token_id: USDT_BSC, token_standard: "erc20" })).toBe(`bsc:${USDT_BSC}`);
    expect(TransferStore.coinFor({ chain: "ethereum", token_id: "native", token_standard: "native" })).toBe("coingecko:ethereum");
  });
});

describe("BNB provider wiring", () => {
  it("buildApp reads BNB through AlchemyProvider on BNB_RPC_URL, checked against chain id 56, rows tagged bnb / BNB", async () => {
    const config = { ...loadConfig({ NODE_ENV: "test", BNB_RPC_URL: "https://bnb-mainnet.g.alchemy.test/v2/k" } as NodeJS.ProcessEnv), dbPath: ":memory:" };
    const urls: string[] = [];
    const { app, ctx } = await buildApp(config, { db: openDb(":memory:"), fetchImpl: alchemyFetch("0x38", urls), logger: false });
    try {
      const p = ctx.providers.bnb;
      expect(p).toBeInstanceOf(AlchemyProvider);
      expect(p).toMatchObject({ chain: "bnb", id: "alchemy-bnb", name: "Alchemy (BNB Chain)" });
      const page = await p.fetchStreamPage(ETH_A, "incoming", null, budgetMs(5000));
      expect(page.transfers[0]).toMatchObject({ chain: "bnb", to: ETH_A, tokenSymbol: "BNB", tokenName: "BNB", priceCoin: "coingecko:binancecoin" });
      expect(urls.length).toBeGreaterThan(0);
      expect(urls.every((u) => u === "https://bnb-mainnet.g.alchemy.test/v2/k")).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe("BNB config", () => {
  it("defaults to BNB Chain's public RPC, overridable (lookups need it to be an Alchemy URL)", () => {
    const d = loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    expect(d.bnbRpcUrl).toBe("https://bsc-dataseed.bnbchain.org");
    const c = loadConfig({ NODE_ENV: "test", BNB_RPC_URL: " https://my-bsc.example/rpc " } as NodeJS.ProcessEnv);
    expect(c.bnbRpcUrl).toBe("https://my-bsc.example/rpc");
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
    expect(health.chains.map((c: { id: string; name: string }) => `${c.id}:${c.name}`)).toEqual(["solana:Solana", "ethereum:Ethereum", "bnb:BNB Chain", "robinhood:Robinhood Chain", "base:Base", "arbitrum:Arbitrum One", "optimism:OP Mainnet", "zora:Zora", "lens:Lens Chain", "story:Data Network", "gnosis:Gnosis Chain", "ronin:Ronin", "rootstock:Rootstock", "zetachain:ZetaChain", "mythos:Mythos", "hyperliquid:HyperEVM"]);
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

// Found in live QA (BNB, 2026-10-23): Alchemy had no decimals for MYX, the row was stored with
// token_decimals NULL and its unscaled base-unit amount, and the pricing pass multiplied that by
// MYX's price -- a ~$12.7 swap (203 MYX) stored as $1.27e19, topping every counterparty table it touched.
describe("transfers with unknown token decimals are never priced", () => {
  let t: TestApp;
  beforeEach(async () => (t = await makeApp()));
  afterEach(async () => t.close());
  const MYX = "0xD82544bf0dfe8385eF8FA34D67e6e4940CC63e16";

  it("sync leaves a decimals-less ERC-20 transfer unpriced (and checked); known-decimals rows still price", async () => {
    const base = Math.floor(Date.now() / 1000) - 3600;
    const unknown = ethTransfer(ETH_A, ETH_B, base, { chain: "bnb", tokenId: MYX, tokenSymbol: "MYX", tokenName: null, tokenDecimals: null, tokenStandard: "erc20", amountRaw: "203085534594432927544", priceCoin: `bsc:${MYX}` });
    const known = ethTransfer(ETH_A, ETH_B, base + 1, { chain: "bnb", tokenId: MYX, tokenSymbol: "MYX", tokenName: null, tokenDecimals: 18, tokenStandard: "erc20", amountRaw: "203085534594432927544", priceCoin: `bsc:${MYX}` });
    t.ctx.store.upsert([unknown, known]);
    await t.ctx.sync.priceAddress("bnb", ETH_A);
    const rows = t.ctx.db.all<{ id: string; usd: number | null; price_checked_at: string | null }>("SELECT id, usd, price_checked_at FROM transfers WHERE chain = 'bnb' ORDER BY block_time");
    expect(rows[0]).toMatchObject({ id: unknown.id, usd: null });
    expect(rows[0]!.price_checked_at).not.toBeNull();
    expect(rows[1]!.usd).toBeCloseTo(203.085534594432927544 * 2000, 6); // test prices: 2000 USD per coin
    const cps = (await t.app.inject(`/api/address/bnb/${ETH_A}/counterparties?flow=out`)).json();
    expect(cps.counterparties[0].usd).toBeLessThan(1e6);
  });

  it("migration 014 clears usd already stored on such rows and leaves every other row's usd alone", async () => {
    const base = Math.floor(Date.now() / 1000) - 3600;
    const bad = ethTransfer(ETH_A, ETH_B, base, { chain: "bnb", tokenId: MYX, tokenSymbol: "MYX", tokenDecimals: null, tokenStandard: "erc20", amountRaw: "203085534594432927544", priceCoin: `bsc:${MYX}` });
    const good = ethTransfer(ETH_A, ETH_B, base + 1, { chain: "bnb", tokenSymbol: "BNB", priceCoin: "coingecko:binancecoin" });
    t.ctx.store.upsert([bad, good]);
    // As the pre-fix pricing pass stored them.
    t.ctx.db.run("UPDATE transfers SET usd = 1.2670168777392e19, price_source = 'defillama', price_checked_at = 'x' WHERE id = ?", bad.id);
    t.ctx.db.run("UPDATE transfers SET usd = 2000, price_source = 'defillama', price_checked_at = 'x' WHERE id = ?", good.id);
    t.ctx.db.run("DELETE FROM schema_migrations WHERE version = '014_unprice_unknown_decimals'");
    expect(t.ctx.db.migrate()).toEqual(["014_unprice_unknown_decimals"]);
    const usd = (id: string) => t.ctx.db.get<{ usd: number | null; price_source: string | null }>("SELECT usd, price_source FROM transfers WHERE id = ?", id);
    expect(usd(bad.id)).toEqual({ usd: null, price_source: null });
    expect(usd(good.id)).toEqual({ usd: 2000, price_source: "defillama" });
  });
});
