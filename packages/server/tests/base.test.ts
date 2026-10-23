import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { AlchemyProvider } from "../src/chain/alchemy.ts";
import { TransferStore } from "../src/chain/store.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { budgetMs } from "../src/lib/http.ts";
import { alchemyFetch, ETH_A, ETH_B, ETH_C, ethTransfer, FakeProvider, makeApp, signup, SOL_A, type Client, type TestApp } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** A transfer on Base: same EVM shape as `ethTransfer`, stamped with Base's chain id. */
const baseTransfer = (from: string, to: string, blockTime: number, opts: Parameters<typeof ethTransfer>[3] = {}) => ethTransfer(from, to, blockTime, { chain: "base", ...opts });

describe("Base provider wiring", () => {
  it("buildApp reads Base through AlchemyProvider on BASE_RPC_URL, checked against chain id 8453, internal transfers included", async () => {
    const url = "https://base-mainnet.g.alchemy.test/v2/k";
    const config = { ...loadConfig({ NODE_ENV: "test", BASE_RPC_URL: url } as NodeJS.ProcessEnv), dbPath: ":memory:" };
    const urls: string[] = [];
    const bodies: any[] = [];
    const inner = alchemyFetch("0x2105", urls);
    const fetchImpl = (async (u: string, init?: RequestInit) => (bodies.push(JSON.parse(String(init!.body))), inner(u, init))) as unknown as typeof fetch;
    const { app, ctx } = await buildApp(config, { db: openDb(":memory:"), fetchImpl, logger: false });
    try {
      const p = ctx.providers.base;
      expect(p).toBeInstanceOf(AlchemyProvider);
      expect(p).toMatchObject({ chain: "base", id: "alchemy-base", name: "Alchemy (Base)" });
      const page = await p.fetchStreamPage(ETH_A, "incoming", null, budgetMs(5000));
      expect(page.transfers[0]).toMatchObject({ chain: "base", tokenSymbol: "ETH", priceCoin: "coingecko:ethereum" });
      expect(urls.every((u) => u === url)).toBe(true);
      // Base is the one of the three where Alchemy serves internal (trace) transfers.
      expect(bodies.find((b) => b.method === "alchemy_getAssetTransfers").params[0].category).toContain("internal");
    } finally {
      await app.close();
    }
  });
});

describe("Base as a first-class chain", () => {
  let t: TestApp;
  let c: Client;
  let baseProvider: FakeProvider;
  const at = Math.floor(Date.now() / 1000) - 86400;
  beforeEach(async () => {
    t = await makeApp();
    // ctx.providers is the same object the sync service and routes read from, so swapping the Base
    // entry here routes every Base lookup to the fake -- no real Blockscout call from a test.
    baseProvider = new FakeProvider("base");
    t.ctx.providers.base = baseProvider;
    c = await signup(t.app, "base-analyst");
  });
  afterEach(async () => t.close());

  it("config: zero-config defaults to Base's public RPC (lookups need it to be an Alchemy URL), overridable", () => {
    const d = loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    expect(d.baseRpcUrl).toBe("https://mainnet.base.org");
    const o = loadConfig({ NODE_ENV: "test", BASE_RPC_URL: " https://base.rpc.example " } as NodeJS.ProcessEnv);
    expect(o.baseRpcUrl).toBe("https://base.rpc.example");
  });

  it("transfers and counterparties for a Base address come from the Base provider, never Ethereum's", async () => {
    baseProvider.add([baseTransfer(ETH_B, ETH_A, at), baseTransfer(ETH_A, ETH_C, at + 1)]);
    t.eth.add([ethTransfer(ETH_B, ETH_A, at + 2)]);
    const r = (await c.get(`/api/transfers?base=base:${ETH_A.toLowerCase()}&limit=50&timeLast=7d`)).json();
    expect(r.transfers).toHaveLength(2);
    expect(r.transfers.every((x: { chain: string }) => x.chain === "base")).toBe(true);
    expect(r.sync.provider).toBe("Fake base");
    const cps = (await c.get(`/api/address/base/${ETH_A}/counterparties?flow=all`)).json();
    expect(cps.counterparties.map((x: { chains: string[] }) => x.chains)).toEqual([["base"], ["base"]]);
    // The same 0x address on Ethereum is its own account with its own history.
    const eth = (await c.get(`/api/transfers?base=ethereum:${ETH_A}&limit=50&timeLast=7d`)).json();
    expect(eth.transfers).toHaveLength(1);
    expect(eth.transfers[0].chain).toBe("ethereum");
  });

  it("a bare 0x ref inside a Base view resolves to Base, and Base refuses non-EVM addresses", async () => {
    baseProvider.add([baseTransfer(ETH_B, ETH_A, at)]);
    const viaChainParam = (await c.get(`/api/transfers?base=${ETH_A}&chain=base&limit=50&timeLast=7d`)).json();
    expect(viaChainParam.transfers.map((x: { chain: string }) => x.chain)).toEqual(["base"]);
    expect((await c.get(`/api/address/base/${SOL_A}`)).statusCode).toBe(400);
    expect((await c.get(`/api/address/base/${ETH_A.toLowerCase()}`)).json()).toMatchObject({ chain: "base", address: ETH_A });
  });

  it("balances route reads the Base provider and prices through it", async () => {
    baseProvider.balances = [
      { tokenId: "native", symbol: "ETH", name: "Ether", decimals: 18, amountRaw: "1000000000000000000", priceCoin: "coingecko:ethereum" },
      { tokenId: BASE_USDC, symbol: "USDC", name: "USD Coin", decimals: 6, amountRaw: "5000000", priceCoin: `base:${BASE_USDC}` },
    ];
    const r = (await c.get(`/api/address/base/${ETH_A}/balances`)).json();
    expect(r.address).toMatchObject({ chain: "base", address: ETH_A });
    expect(r.balances.map((b: { tokenId: string }) => b.tokenId).sort()).toEqual([BASE_USDC, "native"].sort());
    expect(r.totalUsd).toBeGreaterThan(0);
  });

  it("native ETH on Base prices as ether; Base tokens price under DefiLlama's own base: prefix", () => {
    expect(TransferStore.coinFor({ chain: "base", token_id: "native", token_standard: "native" })).toBe("coingecko:ethereum");
    expect(TransferStore.coinFor({ chain: "base", token_id: BASE_USDC, token_standard: "erc20" })).toBe(`base:${BASE_USDC}`);
    expect(TransferStore.coinFor({ chain: "base", token_id: BASE_USDC, token_standard: "erc721" })).toBeNull();
  });

  it("labels: a Base label is its own row next to the same address's Ethereum label, and survives import/export", async () => {
    const tag = (await c.post("/api/tags", { name: "bridge", color: "#0052ff" })).json();
    const onBase = await c.post("/api/labels", { chain: "base", address: ETH_A.toLowerCase(), name: "Base hot wallet", tagIds: [tag.id] });
    expect(onBase.statusCode).toBe(201);
    expect(onBase.json()).toMatchObject({ chain: "base", address: ETH_A });
    expect((await c.post("/api/labels", { chain: "ethereum", address: ETH_A, name: "Eth hot wallet" })).statusCode).toBe(201);
    expect((await c.post("/api/labels", { chain: "base", address: SOL_A, name: "nope" })).statusCode).toBe(400);
    expect((await c.get(`/api/address/base/${ETH_A}`)).json()).toMatchObject({ label: { name: "Base hot wallet" } });
    expect((await c.get(`/api/address/ethereum/${ETH_A}`)).json()).toMatchObject({ label: { name: "Eth hot wallet" } });
    const imp = (await c.post("/api/labels/import", { format: "csv", data: `chain,address,name\nbase,${ETH_B},Imported on Base\nbsc,${ETH_C},Not a chain here`, onConflict: "skip" })).json();
    expect(imp.created).toBe(1);
    expect(imp.skipped).toEqual([{ row: 3, reason: "chain must be one of solana, ethereum, bnb, robinhood, base, arbitrum, optimism, zora, lens, story, gnosis, ronin, rootstock, zetachain, mythos, hyperliquid" }]);
    const csv = (await c.get("/api/labels/export?format=csv")).body;
    expect(csv).toContain(`base,${ETH_A},Base hot wallet`);
    expect(csv).toContain(`base,${ETH_B},Imported on Base`);
  });

  it("search offers a pasted 0x address on every EVM chain, Ethereum first", async () => {
    const hits = (await c.get(`/api/search?q=${ETH_C}`)).json().hits;
    expect(hits.map((h: { type: string; chain: string }) => `${h.type}:${h.chain}`)).toEqual(["address:ethereum", "address:bnb", "address:robinhood", "address:base", "address:arbitrum", "address:optimism", "address:zora", "address:lens", "address:story", "address:gnosis", "address:ronin", "address:rootstock", "address:zetachain", "address:mythos", "address:hyperliquid"]);
  });

  it("traces accept Base address nodes (deterministic ids keyed by chain)", async () => {
    const tr = await c.post("/api/traces", { initialAddress: ETH_A.toLowerCase(), initialChain: "base" });
    expect(tr.statusCode).toBe(201);
    const doc = (await c.get(`/api/traces/${tr.json().id}`)).json();
    expect(doc.nodes).toEqual([expect.objectContaining({ kind: "address", chain: "base", address: ETH_A })]);
    expect((await c.post("/api/traces", { initialAddress: SOL_A, initialChain: "base" })).statusCode).toBe(400);
  });

  it("health lists Base with its provider's own status", async () => {
    const h = (await c.get("/api/health")).json();
    expect(h.chains.find((x: { id: string }) => x.id === "base")).toMatchObject({ id: "base", name: "Base", provider: "Fake base", ok: true });
  });
});

describe("migration 012 (labels.chain CHECK widened to 'base')", () => {
  it("keeps every existing label -- including earlier migrations' BNB and Robinhood ones -- and its tag links, and now accepts 'base'", async () => {
    const t = await makeApp();
    try {
      const c = await signup(t.app, "migrator");
      const tag = (await c.post("/api/tags", { name: "keep", color: "#123456" })).json();
      const lab = (await c.post("/api/labels", { chain: "ethereum", address: ETH_A, name: "Before", tagIds: [tag.id] })).json();
      expect((await c.post("/api/labels", { chain: "bnb", address: ETH_B, name: "On BNB" })).statusCode).toBe(201);
      expect((await c.post("/api/labels", { chain: "robinhood", address: ETH_C, name: "On Robinhood" })).statusCode).toBe(201);
      // Re-run the migration's own SQL against a database that already has data in it -- the
      // situation every real deployment upgrading into it is in.
      t.ctx.db.tx(() => t.ctx.db.exec(readFileSync(join(here, "../src/db/migrations/012_labels_base_chain.sql"), "utf8")));
      expect(t.ctx.db.all("SELECT label_id, tag_id FROM label_tags")).toEqual([{ label_id: lab.id, tag_id: tag.id }]);
      expect(t.ctx.db.all("SELECT chain, name FROM labels ORDER BY name")).toEqual([
        { chain: "ethereum", name: "Before" },
        { chain: "bnb", name: "On BNB" },
        { chain: "robinhood", name: "On Robinhood" },
      ]);
      expect((await c.get(`/api/address/ethereum/${ETH_A}`)).json()).toMatchObject({ label: { name: "Before" }, tags: [{ id: tag.id }] });
      expect((await c.post("/api/labels", { chain: "base", address: ETH_A, name: "After" })).statusCode).toBe(201);
      expect(() => t.ctx.db.run("UPDATE labels SET chain = 'bitcoin' WHERE id = ?", lab.id)).toThrow(/CHECK constraint failed/);
    } finally {
      await t.close();
    }
  });
});
