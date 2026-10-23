import type { Chain } from "@osstrace/contract";
import type { Db } from "../db/index.ts";
import { HttpClient, type Budget } from "../lib/http.ts";
import { nowIso } from "../lib/time.ts";

export type PricePoint = { usd: number | null; symbol: string | null; decimals: number | null };

type LlamaCurrent = { coins: Record<string, { price?: number; symbol?: string; decimals?: number; timestamp?: number }> };
type LlamaBatch = { coins: Record<string, { symbol?: string; prices?: { timestamp: number; price: number }[] }> };

export const SOURCE = "defillama";
const HOUR = 3600;
const CURRENT_TTL_MS = 5 * 60_000;
export const bucketOf = (t: number) => Math.floor(t / HOUR) * HOUR;

/** DefiLlama's own chain prefix for a token coin key (`<prefix>:<contract|mint>`). Not always this
 *  project's chain id: DefiLlama calls BNB Smart Chain "bsc", and a `bnb:0x...` key just prices as
 *  unknown (silently null USD), so every token key must go through this map, never `${chain}:`. */
//
// Robinhood Chain's prefix happens to be "robinhood" -- checked against the live coins API (USDG at
// `robinhood:0x5fc5360d0400a0fd4f2af552add042d716f1d168` prices at ~$1.00), not assumed from the slug.
// It must never be "ethereum": a contract address is only unique per chain, so that key would price a
// Robinhood Chain token as whatever lives at the same address on mainnet. Base's is "base", checked
// the same way (`base:0x8335...2913` prices as USDC, 6 dp).
//
// Checked the same way on 2026-10-23: Arbitrum One is "arbitrum" and OP Mainnet "optimism" (each
// chain's Circle USDC prices at ~$1.00, 6 dp), Zora "zora" (USDzC, WETH), Lens Chain "lens" (WGHO),
// and the Data Network "sty" -- DefiLlama's key from its Story days: `sty:0x1514...0000` (WIP) prices at
// DATA's own price, while `story:`, `data:` and `data_network:` keys all price as nothing.
//
// And on 2026-10-23 again: Gnosis Chain is "xdai" (`xdai:0xe91d...a97d`, WXDAI, prices at ~$1.00), Ronin
// "ronin" (WRON), Rootstock "rsk" (RIF, WRBTC) -- DefiLlama's own chain keys. ("gnosis:" and "rootstock:"
// happen to answer the same today, as aliases; the canonical keys are used.)
export const LLAMA_CHAIN_PREFIX: Record<Chain, string> = {
  ethereum: "ethereum",
  solana: "solana",
  bnb: "bsc",
  robinhood: "robinhood",
  base: "base",
  arbitrum: "arbitrum",
  optimism: "optimism",
  zora: "zora",
  lens: "lens",
  story: "sty",
  gnosis: "xdai",
  ronin: "ronin",
  rootstock: "rsk",
};
/** Native coins are keyed by their CoinGecko id on DefiLlama (BNB's is "binancecoin", not "bnb").
 *  Robinhood Chain pays gas in real ETH -- CoinGecko's asset platform for it says `native_coin_id:
 *  "ethereum"`, DefiLlama's chain list `gasTokenGeckoId: "ethereum"` -- so it prices off ETH's own id.
 *  Base's gas asset is ether too (bridged 1:1, the same asset), so the same series -- and so is
 *  Arbitrum One's, OP Mainnet's and Zora's. Lens Chain's gas token is GHO ("coingecko:gho", ~$1.00),
 *  and the Data Network's is DATA, whose CoinGecko id is still "story-2" from before the rebrand
 *  (DefiLlama answers it with symbol "DATA"). Gnosis Chain's xDAI is "coingecko:xdai" (~$1.00), Ronin's
 *  RON "coingecko:ronin", and Rootstock's RBTC "coingecko:rootstock" -- RBTC's own series (symbol RBTC),
 *  which tracks BTC 1:1 but is the asset actually held, so it's priced as itself. */
export const NATIVE_COIN: Record<Chain, string> = {
  ethereum: "coingecko:ethereum",
  solana: "coingecko:solana",
  bnb: "coingecko:binancecoin",
  robinhood: "coingecko:ethereum",
  base: "coingecko:ethereum",
  arbitrum: "coingecko:ethereum",
  optimism: "coingecko:ethereum",
  zora: "coingecko:ethereum",
  lens: "coingecko:gho",
  story: "coingecko:story-2",
  gnosis: "coingecko:xdai",
  ronin: "coingecko:ronin",
  rootstock: "coingecko:rootstock",
};
export const tokenCoin = (chain: Chain, tokenId: string) => `${LLAMA_CHAIN_PREFIX[chain]}:${tokenId}`;

/**
 * USD prices from the DefiLlama coins API, cached in `prices`. A missing price is stored as NULL and
 * surfaced as `usd: null`; nothing is ever estimated or invented.
 */
export class PriceService {
  readonly http: HttpClient;
  private readonly db: Db;
  private readonly baseUrl: string;
  constructor(db: Db, baseUrl: string, fetchImpl?: typeof fetch) {
    this.db = db;
    this.baseUrl = baseUrl;
    this.http = new HttpClient(SOURCE, 4, fetchImpl);
  }

  private chunks(coins: string[], maxLen = 1500): string[][] {
    const out: string[][] = [];
    let cur: string[] = [];
    let len = 0;
    for (const c of coins) {
      if (cur.length && (len + c.length + 1 > maxLen || cur.length >= 60)) {
        out.push(cur);
        cur = [];
        len = 0;
      }
      cur.push(c);
      len += c.length + 1;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  /** Current prices (5 min cache). Coins without a price map to usd=null. Throws ProviderError if DefiLlama fails. */
  async current(coins: string[], budget?: Budget): Promise<Map<string, PricePoint>> {
    const uniq = [...new Set(coins)];
    const out = new Map<string, PricePoint>();
    const stale: string[] = [];
    const cutoff = new Date(Date.now() - CURRENT_TTL_MS).toISOString();
    for (const c of uniq) {
      const r = this.db.get<{ usd: number | null; symbol: string | null; decimals: number | null; fetched_at: string }>(
        "SELECT usd, symbol, decimals, fetched_at FROM prices WHERE coin = ? AND bucket = -1",
        c,
      );
      if (r && r.fetched_at > cutoff) out.set(c, { usd: r.usd, symbol: r.symbol, decimals: r.decimals });
      else stale.push(c);
    }
    for (const group of this.chunks(stale)) {
      const url = `${this.baseUrl}/prices/current/${group.map(encodeURIComponent).join(",")}`;
      const { data } = await this.http.json<LlamaCurrent>(url, { budget, timeoutMs: 15_000 });
      const at = nowIso();
      this.db.tx(() => {
        for (const c of group) {
          const p = data?.coins?.[c];
          const usd = typeof p?.price === "number" && Number.isFinite(p.price) ? p.price : null;
          const point = { usd, symbol: p?.symbol ?? null, decimals: typeof p?.decimals === "number" ? p.decimals : null };
          out.set(c, point);
          this.db.run(
            `INSERT INTO prices (coin, bucket, usd, symbol, decimals, source, fetched_at) VALUES (?, -1, ?, ?, ?, ?, ?)
             ON CONFLICT (coin, bucket) DO UPDATE SET usd = excluded.usd, symbol = excluded.symbol, decimals = excluded.decimals, fetched_at = excluded.fetched_at`,
            c, point.usd, point.symbol, point.decimals, SOURCE, at,
          );
        }
      });
    }
    return out;
  }

  /** Historical prices at hour buckets. Key of the result: `${coin}|${bucket}`. */
  async historical(points: { coin: string; time: number }[], budget?: Budget): Promise<Map<string, PricePoint>> {
    const out = new Map<string, PricePoint>();
    const need = new Map<string, Set<number>>();
    const recent = Math.floor(Date.now() / 1000) - 2 * 86400;
    const nullRetryCutoff = new Date(Date.now() - 6 * 3600_000).toISOString();
    for (const { coin, time } of points) {
      const b = bucketOf(time);
      const key = `${coin}|${b}`;
      if (out.has(key)) continue;
      const r = this.db.get<{ usd: number | null; symbol: string | null; decimals: number | null; fetched_at: string }>(
        "SELECT usd, symbol, decimals, fetched_at FROM prices WHERE coin = ? AND bucket = ?",
        coin,
        b,
      );
      // A cached "no price" for a recent bucket is retried after 6 h (the provider may backfill it).
      if (r && !(r.usd === null && b > recent && r.fetched_at < nullRetryCutoff)) {
        out.set(key, { usd: r.usd, symbol: r.symbol, decimals: r.decimals });
        continue;
      }
      if (!need.has(coin)) need.set(coin, new Set());
      need.get(coin)!.add(b);
    }
    if (need.size === 0) return out;

    // batchHistorical takes {coin: [timestamps]}; keep each request reasonably small.
    const entries = [...need.entries()].flatMap(([coin, set]) => [...set].map((b) => [coin, b] as const));
    for (let i = 0; i < entries.length; i += 40) {
      const slice = entries.slice(i, i + 40);
      const q: Record<string, number[]> = {};
      for (const [coin, b] of slice) (q[coin] ??= []).push(b + HOUR / 2);
      const url = `${this.baseUrl}/batchHistorical?coins=${encodeURIComponent(JSON.stringify(q))}&searchWidth=3600`;
      const { data } = await this.http.json<LlamaBatch>(url, { budget, timeoutMs: 15_000 });
      const at = nowIso();
      this.db.tx(() => {
        for (const [coin, b] of slice) {
          const series = data?.coins?.[coin];
          const target = b + HOUR / 2;
          let best: { timestamp: number; price: number } | undefined;
          for (const p of series?.prices ?? []) {
            if (Math.abs(p.timestamp - target) > HOUR) continue;
            if (!best || Math.abs(p.timestamp - target) < Math.abs(best.timestamp - target)) best = p;
          }
          const point: PricePoint = {
            usd: best && Number.isFinite(best.price) ? best.price : null,
            symbol: series?.symbol ?? null,
            decimals: null,
          };
          out.set(`${coin}|${b}`, point);
          this.db.run(
            `INSERT INTO prices (coin, bucket, usd, symbol, decimals, source, fetched_at) VALUES (?, ?, ?, ?, NULL, ?, ?)
             ON CONFLICT (coin, bucket) DO UPDATE SET usd = excluded.usd, symbol = excluded.symbol, fetched_at = excluded.fetched_at`,
            coin, b, point.usd, point.symbol, SOURCE, at,
          );
        }
      });
    }
    return out;
  }
}
