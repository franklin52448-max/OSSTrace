// LIVE: talks to eth.blockscout.com, the Solana RPC (public unless SOLANA_RPC_URL[_FILE] is set) and coins.llama.fi.
// Excluded from `npm test`; run with `npm run test:live -w @osstrace/server`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { openDb } from "../../src/db/index.ts";
import { BlockscoutProvider } from "../../src/chain/ethereum.ts";
import { SolanaRpcProvider } from "../../src/chain/solana.ts";
import { PriceService } from "../../src/chain/prices.ts";
import { budgetMs } from "../../src/lib/http.ts";
import { Client, signup } from "../helpers.ts";
import type { FastifyInstance } from "fastify";

const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"; // vitalik.eth, public and well known
const BINANCE_SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"; // widely documented Binance hot wallet

const config = loadConfig();
const nowSec = () => Math.floor(Date.now() / 1000);

describe("live: Blockscout (Ethereum)", () => {
  const p = new BlockscoutProvider(config.ethBlockscoutUrl);
  it("ping", async () => expect((await p.ping()).ok).toBe(true));

  it("token-transfers + transactions pages normalise to transfers touching the address", async () => {
    for (const stream of ["token-transfers", "transactions"]) {
      const page = await p.fetchStreamPage(VITALIK, stream, null, budgetMs(60_000));
      expect(page.oldestTime, stream).not.toBeNull();
      expect(page.newestTime!).toBeLessThanOrEqual(nowSec() + 60);
      expect(page.nextCursor, stream).not.toBeNull();
      for (const t of page.transfers) {
        expect([t.from, t.to]).toContain(VITALIK);
        expect(t.amountRaw).toMatch(/^\d+$/);
        expect(t.chain).toBe("ethereum");
      }
      const next = await p.fetchStreamPage(VITALIK, stream, page.nextCursor, budgetMs(60_000));
      expect(next.newestTime!).toBeLessThanOrEqual(page.oldestTime!);
    }
  });

  it("internal-transactions either loads or fails as a provider_error (it timed out on 2026-10-22)", async () => {
    try {
      const page = await p.fetchStreamPage(VITALIK, "internal-transactions", null, budgetMs(30_000));
      for (const t of page.transfers) expect(t.id).toMatch(/_i\d+$/);
    } catch (e) {
      expect((e as Error).message).toMatch(/blockscout (timed out|is rate limited|returned HTTP \d+|is unreachable)/);
    }
  });

  it("balances include native ETH", async () => {
    const b = await p.fetchBalances(VITALIK, budgetMs(60_000));
    expect(b[0]).toMatchObject({ tokenId: "native", symbol: "ETH", decimals: 18 });
  });
});

describe("live: Solana JSON-RPC", () => {
  const p = new SolanaRpcProvider(config.solanaRpcUrl, config.solanaRpcCustom);
  it("ping", async () => expect((await p.ping()).ok).toBe(true));

  it("one signature page -> parsed transfers touching the wallet (budget-limited on the public RPC)", async () => {
    const page = await p.fetchStreamPage(BINANCE_SOL, "signatures", null, budgetMs(60_000));
    expect(page.newestTime).not.toBeNull();
    for (const t of page.transfers) {
      expect([t.from, t.to, t.fromOwner, t.toOwner]).toContain(BINANCE_SOL);
      expect(t.id).toMatch(/^[1-9A-HJ-NP-Za-km-z]{60,90}_\d+$/);
      expect(t.amountRaw).toMatch(/^\d+$/);
    }
  });

  it("balances include native SOL", async () => {
    const b = await p.fetchBalances(BINANCE_SOL, budgetMs(60_000));
    expect(b[0]).toMatchObject({ tokenId: "native", symbol: "SOL", decimals: 9 });
    expect(BigInt(b[0]!.amountRaw) > 0n).toBe(true);
  });
});

describe("live: DefiLlama", () => {
  it("current and historical prices for ETH and SOL", async () => {
    const db = openDb(":memory:");
    const ps = new PriceService(db, config.defillamaUrl);
    const cur = await ps.current(["coingecko:ethereum", "coingecko:solana"]);
    expect(cur.get("coingecko:ethereum")!.usd).toBeGreaterThan(10);
    expect(cur.get("coingecko:solana")!.usd).toBeGreaterThan(1);
    const t = nowSec() - 3 * 86400;
    const hist = await ps.historical([{ coin: "coingecko:ethereum", time: t }]);
    expect([...hist.values()][0]!.usd).toBeGreaterThan(10);
    db.close();
  });
});

describe("live: full API path", () => {
  let app: FastifyInstance;
  let c: Client;
  beforeAll(async () => {
    const built = await buildApp({ ...config, dbPath: ":memory:" }, { db: openDb(":memory:"), logger: false });
    app = built.app;
    await app.ready();
    c = await signup(app, "live_user");
  });
  afterAll(async () => app.close());

  it("GET /api/transfers for a real Ethereum address", async () => {
    const r = await c.get(`/api/transfers?base=ethereum:${VITALIK}&limit=20&usdGte=1`);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(["ready", "partial"]).toContain(body.sync.state);
    expect(body.transfers.length).toBeGreaterThan(0);
    for (const t of body.transfers) {
      expect(t.usd).toBeGreaterThanOrEqual(1);
      expect(t.priceSource).toBe("defillama");
      expect([t.from.address, t.to.address]).toContain(VITALIK);
    }
  });

  it("GET /api/transfers for a real Solana address (public RPC may only serve a partial page)", async () => {
    const r = await c.get(`/api/transfers?base=solana:${BINANCE_SOL}&limit=20`);
    if (r.statusCode === 502) {
      // Public RPC rate limit with nothing cached: reported as provider_error, never as empty success.
      expect(r.json().error.code).toBe("provider_error");
      return;
    }
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(["ready", "partial", "error"]).toContain(body.sync.state);
    for (const t of body.transfers) {
      const parties = [t.from.address, t.to.address, t.from.ownerAddress?.address, t.to.ownerAddress?.address];
      expect(parties).toContain(BINANCE_SOL);
    }
  });
});
