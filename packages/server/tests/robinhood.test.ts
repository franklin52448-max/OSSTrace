// Robinhood Chain (EVM chain id 4663) as its own chain: read through AlchemyProvider on its own RPC
// URL (chain/alchemy.ts, tested in alchemy.test.ts), the per-chain pricing keys, every route that
// validates a (chain, address), and the migration that widens the two chain CHECKs. Its own Blockscout
// instance (robinhoodchain.blockscout.com) isn't used: its API answered every scripted request with a
// Cloudflare challenge (HTTP 403, `cf-mitigated: challenge`). The token below is the real USDG contract.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { AlchemyProvider } from "../src/chain/alchemy.ts";
import { LLAMA_CHAIN_PREFIX, NATIVE_COIN } from "../src/chain/prices.ts";
import { TransferStore } from "../src/chain/store.ts";
import { loadConfig } from "../src/config.ts";
import { Db, openDb } from "../src/db/index.ts";
import { budgetMs } from "../src/lib/http.ts";
import { alchemyFetch, ETH_A, ETH_B, ethTransfer, makeApp, signup, type Client, type TestApp } from "./helpers.ts";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const HASH = `0x${"1".repeat(64)}`;

describe("Robinhood Chain provider", () => {
  it("buildApp reads Robinhood Chain through AlchemyProvider on ROBINHOOD_RPC_URL, checked against chain id 4663, rows tagged robinhood / ETH", async () => {
    const url = "https://robinhood-mainnet.g.alchemy.test/v2/k";
    const config = { ...loadConfig({ NODE_ENV: "test", ROBINHOOD_RPC_URL: url } as NodeJS.ProcessEnv), dbPath: ":memory:" };
    const urls: string[] = [];
    const { app, ctx } = await buildApp(config, { db: openDb(":memory:"), fetchImpl: alchemyFetch("0x1237", urls), logger: false });
    try {
      const p = ctx.providers.robinhood;
      expect(p).toBeInstanceOf(AlchemyProvider);
      expect(p).toMatchObject({ chain: "robinhood", id: "alchemy-robinhood", name: "Alchemy (Robinhood Chain)" });
      const page = await p.fetchStreamPage(ETH_A, "outgoing", null, budgetMs(5000));
      // ETH on Robinhood Chain, priced off Ethereum's ETH -- but stored under chain robinhood.
      expect(page.transfers[0]).toMatchObject({ chain: "robinhood", tokenSymbol: "ETH", tokenName: "Ether", priceCoin: "coingecko:ethereum" });
      expect(urls.every((u) => u === url)).toBe(true);
      expect(await p.ping()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it("an RPC on another chain is refused before any Robinhood Chain row is read", async () => {
    const config = { ...loadConfig({ NODE_ENV: "test", ROBINHOOD_RPC_URL: "https://eth-mainnet.g.alchemy.test/v2/k" } as NodeJS.ProcessEnv), dbPath: ":memory:" };
    const { app, ctx } = await buildApp(config, { db: openDb(":memory:"), fetchImpl: alchemyFetch("0x1"), logger: false });
    try {
      await expect(ctx.providers.robinhood.fetchStreamPage(ETH_A, "incoming", null, budgetMs(5000))).rejects.toThrow("ROBINHOOD_RPC_URL answers for chain id 1, not Robinhood Chain's 4663 -- check the URL");
    } finally {
      await app.close();
    }
  });

  it("stored rows price per chain: a robinhood native transfer is ETH, never SOL; its tokens never price as Ethereum mainnet's", () => {
    expect(TransferStore.coinFor({ chain: "robinhood", token_id: "native", token_standard: "native" })).toBe("coingecko:ethereum");
    expect(TransferStore.coinFor({ chain: "robinhood", token_id: USDG, token_standard: "erc20" })).toBe(`robinhood:${USDG}`);
    expect(TransferStore.coinFor({ chain: "ethereum", token_id: USDG, token_standard: "erc20" })).toBe(`ethereum:${USDG}`);
    expect(TransferStore.coinFor({ chain: "solana", token_id: "native", token_standard: "native" })).toBe("coingecko:solana");
    expect(NATIVE_COIN.robinhood).toBe("coingecko:ethereum");
    expect(LLAMA_CHAIN_PREFIX.robinhood).toBe("robinhood");
  });
});

describe("Robinhood Chain config", () => {
  it("zero-config defaults to the chain's own public RPC (lookups need it to be an Alchemy URL); env var overrides", () => {
    const d = loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    expect(d.robinhoodRpcUrl).toBe("https://rpc.mainnet.chain.robinhood.com");
    const o = loadConfig({ NODE_ENV: "test", ROBINHOOD_RPC_URL: " https://rh-rpc.example/key " } as NodeJS.ProcessEnv);
    expect(o.robinhoodRpcUrl).toBe("https://rh-rpc.example/key");
  });
  it("deposit settings: no Robinhood Chain wallet unless configured; USDG is the default token, extended (never replaced) by env", () => {
    const d = loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    expect(d.depositWallets.robinhood).toBeUndefined();
    expect([...d.depositAllowedTokens.robinhood]).toEqual([USDG]);
    // Ethereum's USDC/USDT never leak into Robinhood Chain's allowlist (or vice versa).
    expect(d.depositAllowedTokens.robinhood.has("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toBe(false);
    expect(d.depositAllowedTokens.ethereum.has(USDG)).toBe(false);
    const o = loadConfig({ NODE_ENV: "test", DEPOSIT_WALLET_ROBINHOOD: ` ${ETH_B} `, DEPOSIT_ALLOWED_TOKENS_ROBINHOOD: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34, " } as NodeJS.ProcessEnv);
    expect(o.depositWallets.robinhood).toBe(ETH_B);
    expect([...o.depositAllowedTokens.robinhood]).toEqual([USDG, "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34"]);
  });
});

describe("Robinhood Chain through the API", () => {
  let t: TestApp;
  let c: Client;
  const base = Math.floor(Date.now() / 1000) - 86400;
  beforeEach(async () => {
    t = await makeApp();
    c = await signup(t.app, "rh-analyst");
  });
  afterEach(async () => t.close());

  const rhTransfer = (from: string, to: string, time: number) => ethTransfer(from, to, time, { chain: "robinhood" });

  it("a 0x address is valid under /api/address/robinhood/... and reads from the robinhood provider, not Ethereum's", async () => {
    t.rh.balances = [{ tokenId: "native", symbol: "ETH", name: "Ether", decimals: 18, amountRaw: "2000000000000000000", priceCoin: "coingecko:ethereum" }];
    const r = await c.get(`/api/address/robinhood/${ETH_A.toLowerCase()}/balances`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ address: { chain: "robinhood", address: ETH_A }, balances: [{ tokenId: "native", symbol: "ETH", amount: "2", usd: 4000 }] });
    expect((await c.get(`/api/address/robinhood/So11111111111111111111111111111111111111112`)).statusCode).toBe(400);
    expect((await c.get(`/api/address/notachain/${ETH_A}`)).statusCode).toBe(400);
  });

  it("transfers on Robinhood Chain and Ethereum for the same address stay apart", async () => {
    t.ctx.store.upsert([rhTransfer(ETH_B, ETH_A, base + 1), rhTransfer(ETH_A, ETH_B, base + 2), ethTransfer(ETH_B, ETH_A, base + 3)]);
    await t.ctx.sync.priceAddress("robinhood", ETH_A);
    const rh = (await c.get(`/api/transfers?base=robinhood:${ETH_A}`)).json();
    expect(rh.count.value).toBe(2);
    expect(rh.transfers.every((x: { chain: string; usd: number }) => x.chain === "robinhood" && x.usd === 2000)).toBe(true);
    // A bare address with chain=robinhood means Robinhood Chain, not the 0x default of Ethereum.
    expect((await c.get(`/api/transfers?base=${ETH_A}&chain=robinhood`)).json().count.value).toBe(2);
    expect((await c.get(`/api/transfers?base=ethereum:${ETH_A}`)).json().count.value).toBe(1);
  });

  it("labels are per chain: the same address can carry a different label on Robinhood Chain than on Ethereum", async () => {
    const rh = await c.post("/api/labels", { chain: "robinhood", address: ETH_A.toLowerCase(), name: "RH treasury" });
    expect(rh.statusCode).toBe(201);
    expect(rh.json()).toMatchObject({ chain: "robinhood", address: ETH_A });
    expect((await c.post("/api/labels", { chain: "ethereum", address: ETH_A, name: "Mainnet hot wallet" })).statusCode).toBe(201);
    const info = (await c.get(`/api/address/robinhood/${ETH_A}`)).json();
    expect(info.label.name).toBe("RH treasury");
    const imp = (await c.post("/api/labels/import", { format: "csv", data: `chain,address,name\nrobinhood,${ETH_B},Imported RH\ndogecoin,${ETH_B},nope`, onConflict: "update" })).json();
    expect(imp.created).toBe(1);
    expect(imp.skipped).toEqual([{ row: 3, reason: "chain must be one of solana, ethereum, bnb, robinhood, base, arbitrum, optimism, zora, lens, story, gnosis, ronin, rootstock" }]); // row 1 is the CSV header
  });

  it("health lists Robinhood Chain by its display name", async () => {
    const h = (await c.get("/api/health")).json();
    expect(h.chains).toContainEqual(expect.objectContaining({ id: "robinhood", name: "Robinhood Chain", provider: "Fake robinhood", ok: true }));
  });
});

describe("migrations 009/010: widening the labels and bounty_deposits chain CHECKs to robinhood", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../src/db/migrations");
  const files = readdirSync(dir).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
  const now = "2026-10-01T00:00:00.000Z";
  /** A database at every migration before `version`, so rows can be written under the old CHECKs. */
  function dbBefore(version: string) {
    const db = new Db(":memory:");
    const apply = (pred: (f: string) => boolean) => {
      for (const f of files.filter(pred)) db.tx(() => db.exec(readFileSync(join(dir, f), "utf8")));
    };
    apply((f) => f < version);
    db.run("INSERT INTO users (id, username, display_name, created_at, updated_at) VALUES ('u1', 'u1', 'U', ?, ?)", now, now);
    return { db, rest: () => apply((f) => f >= version) };
  }
  const insertLabel = (db: Db, id: string, chain: string, address: string) =>
    db.run("INSERT INTO labels (id, user_id, chain, address, name, created_at, updated_at) VALUES (?, 'u1', ?, ?, 'L', ?, ?)", id, chain, address, now, now);

  it("009 keeps every existing label (bnb ones too) and its tag links, then accepts robinhood labels", () => {
    const { db, rest } = dbBefore("009");
    db.run("INSERT INTO tags (id, user_id, name, name_key, color, created_at) VALUES ('t1', 'u1', 'cex', 'cex', '#000000', ?)", now);
    insertLabel(db, "l1", "ethereum", ETH_A);
    db.run("INSERT INTO label_tags (label_id, tag_id) VALUES ('l1', 't1')");
    insertLabel(db, "lb", "bnb", ETH_A);
    expect(() => insertLabel(db, "l2", "robinhood", ETH_A)).toThrow(/CHECK/);

    rest();
    // Foreign keys are on during migrations, so a naive DROP TABLE labels would have cascade-deleted this.
    expect(db.all("SELECT label_id, tag_id FROM label_tags")).toEqual([{ label_id: "l1", tag_id: "t1" }]);
    expect(db.all<{ id: string }>("SELECT id FROM labels ORDER BY id").map((r) => r.id)).toEqual(["l1", "lb"]);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    insertLabel(db, "l2", "robinhood", ETH_A);
    expect(() => insertLabel(db, "l2b", "robinhood", ETH_A)).toThrow(/UNIQUE/); // (user, chain, address) still unique
    expect(() => insertLabel(db, "l3", "bitcoin", ETH_B)).toThrow(/CHECK/);
    // Deleting a label still cascades to its tag links: label_tags' foreign key resolves to the new table.
    db.run("DELETE FROM labels WHERE id = 'l1'");
    expect(db.all("SELECT * FROM label_tags")).toEqual([]);
    db.close();
  });

  it("010 keeps every existing deposit (bnb ones too) and its case-insensitive dedupe, then accepts robinhood deposits", () => {
    const { db, rest } = dbBefore("010");
    db.run("INSERT INTO bounties (id, status, title, description, reward, opened_by, opened_at) VALUES ('b1', 'open', 'T', 'D', 'R', 'u1', ?)", now);
    const deposit = (id: string, chain: string, txRef: string) =>
      db.run("INSERT INTO bounty_deposits (id, bounty_id, chain, amount, tx_ref, from_address, to_wallet, recorded_by, recorded_at) VALUES (?, 'b1', ?, '1', ?, ?, ?, 'u1', ?)", id, chain, txRef, ETH_A, ETH_B, now);
    deposit("d1", "ethereum", HASH);
    deposit("db", "bnb", HASH);
    expect(() => deposit("d2", "robinhood", HASH)).toThrow(/CHECK/);

    rest();
    expect(db.all<{ id: string }>("SELECT id FROM bounty_deposits").map((r) => r.id).sort()).toEqual(["d1", "db"]);
    deposit("d2", "robinhood", HASH); // same hash, other chain: a different payment
    expect(() => deposit("d3", "robinhood", HASH.toUpperCase().replace("0X", "0x"))).toThrow(/UNIQUE/);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    db.close();
  });
});
