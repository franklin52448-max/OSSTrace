import { describe, expect, it } from "vitest";
import { formatUnits } from "../src/chain/amount.ts";
import { BlockscoutProvider, normalizeEthBalances, normalizeEthInternal, normalizeEthTokenTransfers, normalizeEthTransactions } from "../src/chain/ethereum.ts";
import { normalizeSolanaBalances, normalizeSolanaTx, SolanaRpcProvider, touches, type SolTx } from "../src/chain/solana.ts";
import { PriceService } from "../src/chain/prices.ts";
import { httpsUrl, TokenLogoService } from "../src/chain/tokenLogos.ts";
import { openDb } from "../src/db/index.ts";
import { budgetMs } from "../src/lib/http.ts";
import { ProviderError } from "../src/lib/errors.ts";
import { fixture } from "./helpers.ts";

const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const BINANCE_SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

describe("formatUnits", () => {
  it.each([
    ["1000000000000000000", 18, "1"],
    ["1", 18, "0.000000000000000001"],
    ["123456789", 6, "123.456789"],
    ["1200", 2, "12"],
    ["5", 0, "5"],
    ["5", null, "5"],
    ["200000000000000000000010156", 18, "200000000.000000000000010156"],
  ] as const)("%s / 10^%s = %s", (raw, d, out) => expect(formatUnits(raw, d)).toBe(out));
});

describe("Blockscout normalisation (recorded 2026-10-22)", () => {
  it("transactions: only successful native value transfers, EIP-55 addresses, id <hash>_t0", () => {
    const page = fixture("blockscout/transactions.vitalik.json");
    const out = normalizeEthTransactions(page.items);
    const expected = page.items.filter((t: any) => t.status === "ok" && t.value !== "0");
    expect(out).toHaveLength(expected.length);
    expect(out.length).toBeGreaterThan(0);
    for (const t of out) {
      expect(t.id).toBe(`${t.txHash}_t0`);
      expect(t.tokenId).toBe("native");
      expect(t.tokenDecimals).toBe(18);
      expect(t.from).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect([t.from, t.to]).toContain(VITALIK);
      expect(BigInt(t.amountRaw) > 0n).toBe(true);
      expect(t.priceCoin).toBe("coingecko:ethereum");
    }
    // the failed ("out of gas") transfer is excluded
    const failed = page.items.find((t: any) => t.status === "error");
    expect(out.find((t) => t.txHash === failed.hash)).toBeUndefined();
    expect(page.next_page_params).toMatchObject({ block_number: expect.any(Number), index: expect.any(Number) });
  });

  it("token transfers: ERC-20 amounts with decimals, ERC-721 as one unit without a price coin", () => {
    const page = fixture("blockscout/token-transfers.vitalik.json");
    const out = normalizeEthTokenTransfers(page.items);
    const dai = out.find((t) => t.tokenSymbol === "DAI")!;
    expect(dai).toMatchObject({ tokenStandard: "erc20", tokenDecimals: 18, amountRaw: "3888888888888", tokenId: "0x6B175474E89094C44Da98b954EedeAC495271d0F", priceCoin: "ethereum:0x6B175474E89094C44Da98b954EedeAC495271d0F" });
    expect(formatUnits(dai.amountRaw, dai.tokenDecimals)).toBe("0.000003888888888888");
    expect(dai.id).toMatch(/^0x[0-9a-f]{64}_\d+$/);
    const nft = out.find((t) => t.tokenStandard === "erc721")!;
    expect(nft).toMatchObject({ amountRaw: "1", priceCoin: null, tokenDecimals: 0 });
    expect(nft.tokenName).toMatch(/#\d+$/);
    expect(new Set(out.map((t) => t.id)).size).toBe(out.length);
  });

  it("internal transactions: successful value-moving calls, id <hash>_i<index>", () => {
    const page = fixture("blockscout/internal-transactions.sample.json");
    const out = normalizeEthInternal(page.items);
    const expected = page.items.filter((t: any) => t.success && t.value !== "0" && (t.to || t.created_contract));
    expect(out).toHaveLength(expected.length);
    for (const t of out) expect(t.id).toMatch(/^0x[0-9a-f]{64}_i\d+$/);
  });

  it("balances: native from coin_balance, ERC-20 only", () => {
    const out = normalizeEthBalances(fixture("blockscout/address.vitalik.json"), fixture("blockscout/token-balances.vitalik.json"));
    expect(out[0]).toMatchObject({ tokenId: "native", symbol: "ETH", decimals: 18, amountRaw: "5773252986299759339" });
    expect(out.slice(1).every((b) => b.priceCoin?.startsWith("ethereum:0x"))).toBe(true);
  });

  it("balances: token logos come from Blockscout's icon_url, https only", () => {
    const tokens = fixture("blockscout/token-balances.vitalik.json");
    const out = normalizeEthBalances(fixture("blockscout/address.vitalik.json"), tokens);
    const withIcon = out.filter((b) => b.logoUrl);
    expect(withIcon.length).toBeGreaterThan(0);
    expect(withIcon.every((b) => b.logoUrl!.startsWith("https://"))).toBe(true);
    expect(out[0]!.logoUrl).toBeUndefined();
  });

  it("fetchStreamPage passes next_page_params back as query params and maps 429 to provider_error", async () => {
    const urls: string[] = [];
    let calls = 0;
    const fetchImpl = (async (u: string) => {
      urls.push(String(u));
      calls++;
      if (calls === 3) return new Response("slow down", { status: 429, headers: { "retry-after": "60" } });
      return new Response(JSON.stringify(fixture("blockscout/transactions.vitalik.json")), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new BlockscoutProvider("https://eth.blockscout.test", fetchImpl);
    const first = await p.fetchStreamPage(VITALIK.toLowerCase(), "transactions", null, budgetMs(5000));
    expect(urls[0]).toBe(`https://eth.blockscout.test/api/v2/addresses/${VITALIK}/transactions`);
    expect(first.nextCursor).not.toBeNull();
    await p.fetchStreamPage(VITALIK, "transactions", first.nextCursor, budgetMs(5000));
    expect(urls[1]).toContain("block_number=26068237");
    expect(urls[1]).toContain("items_count=50");
    const err = await p.fetchStreamPage(VITALIK, "transactions", null, budgetMs(5000)).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe("blockscout is rate limited");
    expect(err.retryAfterSec).toBe(60);
    expect(err.message).not.toContain("blockscout.test"); // no URLs in errors
  });
});

describe("Solana normalisation (recorded 2026-10-22)", () => {
  const tx = (name: string) => fixture<SolTx>(`solana/tx.${name}.json`);

  it("top-level transferChecked: token accounts mapped to owner wallets via token balances", () => {
    const t = tx("transferChecked-top");
    const out = normalizeSolanaTx(t);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: `${t.transaction.signatures[0]}_0`,
      from: "1YukAxo5AycHTrGApBbHyfzSysboifD4YBtGGwwTStU",
      fromOwner: BINANCE_SOL,
      to: "A8eWEe4rTiMbkLDUT3PfSqEEe713vB2Uwnfp8P298aJW",
      toOwner: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",
      tokenId: "FQgtfugBdpFN7PZ6NdPrZpVLDBrPGxXesi4gVu3vErhY",
      tokenDecimals: 9,
      amountRaw: "36807899000000000",
      tokenStandard: "spl",
      blockNumber: t.slot,
      blockTime: t.blockTime,
    });
    expect(touches(out[0]!, BINANCE_SOL)).toBe(true);
  });

  it("system transfers (single and multiple) in instruction order with ordinals", () => {
    const single = normalizeSolanaTx(tx("system-single"));
    expect(single).toHaveLength(1);
    expect(single[0]).toMatchObject({ tokenId: "native", tokenSymbol: "SOL", tokenDecimals: 9, priceCoin: "coingecko:solana" });
    const multi = normalizeSolanaTx(tx("system-multi"));
    expect(multi.length).toBeGreaterThanOrEqual(3);
    expect(multi.map((m) => m.id.split("_")[1])).toEqual(multi.map((_, i) => String(i)));
  });

  it("inner instructions incl. Token-2022 transferChecked and inner system transfers", () => {
    const t = tx("inner-token2022");
    const out = normalizeSolanaTx(t);
    const kinds = out.map((o) => (o.tokenId === "native" ? "sol" : o.tokenId));
    expect(kinds).toContain("sol");
    expect(kinds).toContain("4fbst6dkZbSHGm39Wxa24SyLAFBPuqkk5W8xo47LS6ea"); // Token-2022 mint
    const t22 = out.find((o) => o.tokenId === "4fbst6dkZbSHGm39Wxa24SyLAFBPuqkk5W8xo47LS6ea")!;
    expect(t22.amountRaw).toBe("1000000000000000000");
    expect(new Set(out.map((o) => o.id)).size).toBe(out.length);
  });

  it("v0 transaction with ATA creation + transferChecked", () => {
    const out = normalizeSolanaTx(tx("v0-ata-transferChecked"));
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.every((o) => o.tokenStandard === "spl" || o.tokenStandard === "native")).toBe(true);
  });

  it("failed transactions move nothing", () => {
    const t = tx("system-single");
    expect(normalizeSolanaTx({ ...t, meta: { ...t.meta!, err: { InstructionError: [0, "Custom"] } } })).toEqual([]);
  });

  it("balances aggregate token accounts per mint and include native SOL", () => {
    const bal = fixture("solana/getBalance.binance.json").result.value as number;
    const accts = fixture("solana/getTokenAccountsByOwner.binance.json").result.value;
    const out = normalizeSolanaBalances(bal, accts);
    expect(out[0]).toMatchObject({ tokenId: "native", decimals: 9, amountRaw: String(bal) });
    expect(out.slice(1).every((b) => b.priceCoin === `solana:${b.tokenId}`)).toBe(true);
  });

  it("wallet-only mode (maxTokenAccounts 0): signature paging + getTransaction", async () => {
    const sigs = fixture("solana/signatures.binance.json").result.slice(0, 10);
    const byName: Record<string, SolTx> = {};
    for (const n of ["transferChecked-top", "system-single", "system-multi", "inner-token2022", "v0-ata-transferChecked"]) {
      const t = tx(n);
      byName[t.transaction.signatures[0]!] = t;
    }
    const methods: string[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      methods.push(body.method);
      if (body.method === "getSignaturesForAddress") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: sigs }));
      const t = byName[body.params[0]] ?? null;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: t }));
    }) as unknown as typeof fetch;
    const p = new SolanaRpcProvider("https://rpc.test", false, fetchImpl, { maxTokenAccounts: 0 });
    const page = await p.fetchStreamPage(BINANCE_SOL, "signatures", null, budgetMs(10_000));
    expect(methods[0]).toBe("getSignaturesForAddress");
    expect(methods.filter((m) => m === "getTransaction")).toHaveLength(10);
    expect(page.nextCursor).not.toBeNull(); // 10 of limit 10: more may exist
    expect(page.newestTime).toBe(sigs[0].blockTime);
    expect(page.oldestTime).toBe(sigs[9].blockTime);
    expect(page.transfers.every((t) => touches(t, BINANCE_SOL))).toBe(true);
    expect(page.transfers.length).toBeGreaterThan(0);
  });

  it("JSON-RPC rate-limit errors become provider_error without leaking the URL", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 429, message: "Too many requests" } }))) as unknown as typeof fetch;
    const p = new SolanaRpcProvider("https://secret-key.rpc.test/abc123", true, fetchImpl);
    const e = await p.fetchStreamPage(BINANCE_SOL, "signatures", null, budgetMs(3000)).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).not.toContain("abc123");
    expect(p.name).toBe("Solana JSON-RPC (custom endpoint)");
  });
});

describe("DefiLlama prices (recorded 2026-10-22)", () => {
  it("historical: maps batchHistorical points to hour buckets, unknown coins become null and are cached", async () => {
    const db = openDb(":memory:");
    let calls = 0;
    const fetchImpl = (async (u: string) => {
      calls++;
      expect(String(u)).toContain("/batchHistorical?coins=");
      return new Response(JSON.stringify(fixture("defillama/batchHistorical.json")));
    }) as unknown as typeof fetch;
    const ps = new PriceService(db, "https://coins.test", fetchImpl);
    const pts = [
      { coin: "coingecko:ethereum", time: 1792539697 },
      { coin: "ethereum:0x6B175474E89094C44Da98b954EedeAC495271d0F", time: 1792539697 },
      { coin: "ethereum:0x53EDeacdA5167731d830F6e9FC17d365F5070060", time: 1792539697 }, // NFT contract: no price
    ];
    const m = await ps.historical(pts);
    const b = Math.floor(1792539697 / 3600) * 3600;
    expect(m.get(`coingecko:ethereum|${b}`)!.usd).toBeCloseTo(2445.57, 1);
    expect(m.get(`ethereum:0x6B175474E89094C44Da98b954EedeAC495271d0F|${b}`)!.usd).toBeCloseTo(1.0, 2);
    expect(m.get(`ethereum:0x53EDeacdA5167731d830F6e9FC17d365F5070060|${b}`)!.usd).toBeNull();
    await ps.historical(pts);
    expect(calls).toBe(1); // cached, including the null
    db.close();
  });

  it("current: price + symbol per coin, missing coins are null", async () => {
    const db = openDb(":memory:");
    const fetchImpl = (async () => new Response(JSON.stringify(fixture("defillama/current.json")))) as unknown as typeof fetch;
    const ps = new PriceService(db, "https://coins.test", fetchImpl);
    const m = await ps.current(["coingecko:ethereum", "coingecko:solana", "solana:NotARealMint1111111111111111111111111111111"]);
    expect(m.get("coingecko:ethereum")).toMatchObject({ symbol: "ETH" });
    expect(m.get("coingecko:ethereum")!.usd).toBeGreaterThan(0);
    expect(m.get("solana:NotARealMint1111111111111111111111111111111")!.usd).toBeNull();
    db.close();
  });
});

describe("token logos", () => {
  it("httpsUrl keeps only plain https URLs", () => {
    expect(httpsUrl("https://ipfs.io/ipfs/abc")).toBe("https://ipfs.io/ipfs/abc");
    for (const bad of ["http://x.test/a.png", "data:image/png;base64,AAAA", "javascript:alert(1)", "/logo.png", "", null, 42, "https://" + "a".repeat(2100)]) {
      expect(httpsUrl(bad)).toBeNull();
    }
  });

  it("Solana logos from Jupiter: batched, unsafe icons dropped, misses cached", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (u: string) => {
      urls.push(String(u));
      const ids = new URL(String(u)).searchParams.get("query")!.split(",");
      const body = ids
        .filter((id) => id !== "MISSING")
        .map((id) => ({ id, icon: id === "UNSAFE" ? "javascript:alert(1)" : `https://img.test/${id}.png` }));
      return new Response(JSON.stringify(body));
    }) as unknown as typeof fetch;
    const svc = new TokenLogoService("https://jup.test/tokens/v2", fetchImpl);
    const mints = ["A", "UNSAFE", "MISSING", ...Array.from({ length: 120 }, (_, i) => `M${i}`)];
    const out = await svc.solana(mints, budgetMs(5000));
    expect(urls).toHaveLength(2);
    expect(urls[0]).toMatch(/^https:\/\/jup\.test\/tokens\/v2\/search\?query=/);
    expect(out.get("A")).toBe("https://img.test/A.png");
    expect(out.get("UNSAFE")).toBeNull();
    expect(out.get("MISSING")).toBeNull();
    expect(out.size).toBe(mints.length);
    await svc.solana(["A", "MISSING"], budgetMs(5000));
    expect(urls).toHaveLength(2);
  });
});
