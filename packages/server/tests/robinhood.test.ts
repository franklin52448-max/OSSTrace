// Robinhood Chain (EVM chain id 4663) as its own chain: the shared Blockscout provider pointed at
// its own instance, the per-chain pricing keys, every route that validates a (chain, address), and
// the migration that widens the two chain CHECKs.
//
// The Blockscout bodies below are hand-built in the exact /api/v2 shape the recorded Ethereum
// fixtures use (tests/fixtures/blockscout/), not recordings: robinhoodchain.blockscout.com's API
// answered every scripted request with a Cloudflare challenge (HTTP 403, `cf-mitigated: challenge`)
// when this was written, so there was nothing real to record. The token is the real USDG contract.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockscoutProvider } from "../src/chain/ethereum.ts";
import { LLAMA_CHAIN_PREFIX, NATIVE_COIN } from "../src/chain/prices.ts";
import { TransferStore } from "../src/chain/store.ts";
import { loadConfig } from "../src/config.ts";
import { Db } from "../src/db/index.ts";
import { budgetMs } from "../src/lib/http.ts";
import { ProviderError } from "../src/lib/errors.ts";
import { ETH_A, ETH_B, ethTransfer, makeApp, signup, type Client, type TestApp } from "./helpers.ts";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const BASE = "https://robinhoodchain.blockscout.test";
const HASH = `0x${"1".repeat(64)}`;
const TS = "2026-10-20T12:00:00.000000Z";

const page = (items: unknown[]) => ({ items, next_page_params: null });
const bsTx = { hash: HASH, block_number: 9_000_000, timestamp: TS, from: { hash: ETH_A.toLowerCase() }, to: { hash: ETH_B.toLowerCase() }, value: "250000000000000000", status: "ok" };
const bsTokenTransfer = {
  transaction_hash: HASH,
  log_index: 3,
  block_number: 9_000_000,
  timestamp: TS,
  from: { hash: ETH_A },
  to: { hash: ETH_B },
  token: { address_hash: USDG.toLowerCase(), decimals: "6", name: "Global Dollar", symbol: "USDG", type: "ERC-20" },
  total: { decimals: "6", value: "12500000" },
};

/** Answers only at BASE -- a request that went to eth.blockscout.com (or anywhere else) fails the test. */
function robinhoodBlockscout(urls: string[]): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    urls.push(url);
    if (!url.startsWith(`${BASE}/api/v2/`)) return new Response("wrong host", { status: 418 });
    const path = new URL(url).pathname;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (path.endsWith("/transactions")) return json(page([bsTx]));
    if (path.endsWith("/token-transfers")) return json(page([bsTokenTransfer]));
    if (path.endsWith("/internal-transactions")) return json(page([]));
    if (path.endsWith("/token-balances")) return json([{ token: bsTokenTransfer.token, token_id: null, value: "40000000" }]);
    if (path === `/api/v2/addresses/${ETH_A}`) return json({ hash: ETH_A, coin_balance: "1500000000000000000", is_contract: false });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("Robinhood Chain via its own Blockscout instance", () => {
  it("stores rows under chain robinhood: native as ETH priced off Ethereum's ETH, tokens under DefiLlama's robinhood key", async () => {
    const urls: string[] = [];
    const p = new BlockscoutProvider(BASE, robinhoodBlockscout(urls), "robinhood");
    expect(p.chain).toBe("robinhood");
    expect(p.id).toBe("blockscout-robinhood");
    expect(p.name).toBe("Blockscout (robinhoodchain.blockscout.test)");

    const native = await p.fetchStreamPage(ETH_A.toLowerCase(), "transactions", null, budgetMs(5000));
    expect(urls[0]).toBe(`${BASE}/api/v2/addresses/${ETH_A}/transactions`);
    expect(native.transfers).toEqual([
      expect.objectContaining({ chain: "robinhood", id: `${HASH}_t0`, from: ETH_A, to: ETH_B, tokenId: "native", tokenSymbol: "ETH", amountRaw: "250000000000000000", priceCoin: "coingecko:ethereum" }),
    ]);

    const tokens = await p.fetchStreamPage(ETH_A, "token-transfers", null, budgetMs(5000));
    expect(tokens.transfers).toEqual([
      expect.objectContaining({ chain: "robinhood", id: `${HASH}_3`, tokenId: USDG, tokenSymbol: "USDG", tokenDecimals: 6, tokenStandard: "erc20", priceCoin: `robinhood:${USDG}` }),
    ]);

    const balances = await p.fetchBalances(ETH_A, budgetMs(5000));
    expect(balances).toEqual([
      expect.objectContaining({ tokenId: "native", symbol: "ETH", amountRaw: "1500000000000000000", priceCoin: "coingecko:ethereum" }),
      expect.objectContaining({ tokenId: USDG, symbol: "USDG", decimals: 6, amountRaw: "40000000", priceCoin: `robinhood:${USDG}` }),
    ]);
    // Every request went to Robinhood Chain's own instance.
    expect(urls.every((u) => u.startsWith(BASE))).toBe(true);
  });

  it("the Ethereum provider is unchanged by the new parameter: chain, id and price keys stay Ethereum's", async () => {
    const p = new BlockscoutProvider(BASE, robinhoodBlockscout([]));
    expect(p.chain).toBe("ethereum");
    expect(p.id).toBe("blockscout");
    const tokens = await p.fetchStreamPage(ETH_A, "token-transfers", null, budgetMs(5000));
    expect(tokens.transfers[0]).toMatchObject({ chain: "ethereum", priceCoin: `ethereum:${USDG}` });
  });

  it("a Cloudflare challenge page (what the instance served scripted clients when this was written) is a provider error naming the chain's instance, never a URL", async () => {
    const challenge = (async () =>
      new Response("<!DOCTYPE html><title>Just a moment...</title>", { status: 403, headers: { "content-type": "text/html", "cf-mitigated": "challenge" } })) as unknown as typeof fetch;
    const p = new BlockscoutProvider(BASE, challenge, "robinhood");
    const err = await p.fetchStreamPage(ETH_A, "transactions", null, budgetMs(5000)).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe("blockscout-robinhood returned HTTP 403");
    expect(err.message).not.toContain("blockscout.test");
    expect((await p.ping()).ok).toBe(false);
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
  it("zero-config defaults to the chain's own public RPC and per-chain Blockscout instance; env vars override", () => {
    const d = loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    expect(d.robinhoodRpcUrl).toBe("https://rpc.mainnet.chain.robinhood.com");
    expect(d.robinhoodBlockscoutUrl).toBe("https://robinhoodchain.blockscout.com");
    const o = loadConfig({ NODE_ENV: "test", ROBINHOOD_RPC_URL: " https://rh-rpc.example/key ", ROBINHOOD_BLOCKSCOUT_URL: "https://rh-explorer.example/" } as NodeJS.ProcessEnv);
    expect(o.robinhoodRpcUrl).toBe("https://rh-rpc.example/key");
    expect(o.robinhoodBlockscoutUrl).toBe("https://rh-explorer.example");
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
    expect(imp.skipped).toEqual([{ row: 3, reason: "chain must be one of solana, ethereum, bnb, robinhood, base" }]); // row 1 is the CSV header
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
