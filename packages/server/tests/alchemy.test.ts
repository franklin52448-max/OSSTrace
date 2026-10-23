// AlchemyProvider: BNB Chain, Robinhood Chain and Base history/balances through Alchemy's enhanced
// JSON-RPC methods. The response rows below are real Alchemy answers recorded 2026-10-23 (BNB:
// PancakeSwap's router; Base: an ERC-721 / ERC-1155 / internal transfer, real USDC/WETH metadata),
// trimmed to a few rows and with addresses swapped for the test fixtures where a test needs them.
import { describe, expect, it } from "vitest";
import { toChecksumAddress } from "@osstrace/contract";
import { AlchemyProvider, normalizeAlchemyTransfers } from "../src/chain/alchemy.ts";
import { ProviderError } from "../src/lib/errors.ts";
import { budgetMs } from "../src/lib/http.ts";
import { ETH_A, ETH_B } from "./helpers.ts";

const RPC = "https://bnb-mainnet.g.alchemy.test/v2/TESTKEY0123456789abcdef";
const A = ETH_A.toLowerCase();
const B = ETH_B.toLowerCase();
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_WETH = "0x4200000000000000000000000000000000000006";
const TX1 = "0x00914ca04008af5fc4af5894db23f347f6d4ebb90efa6dd066707767897992ef";
const TX2 = "0x96ccd5cb888bf37f9b2303fb238197f038c6004cff7afc9c625f209f98bf166d";

const erc20Row = {
  blockNum: "0x7b5b46a",
  uniqueId: `${TX1}:log:132`,
  hash: TX1,
  from: B,
  to: A,
  value: 0.20041201009922657,
  erc721TokenId: null,
  erc1155Metadata: [],
  tokenId: null,
  asset: "WBNB",
  category: "erc20",
  rawContract: { value: "0x2c801a94eafb7d9", address: WBNB.toLowerCase(), decimal: "0x12" },
  metadata: { blockTimestamp: "2026-10-23T15:49:29.000Z" },
};
const externalRow = {
  blockNum: "0x7b5b468",
  uniqueId: `${TX2}:external`,
  hash: TX2,
  from: B,
  to: A,
  value: 0.059295,
  erc721TokenId: null,
  erc1155Metadata: null,
  tokenId: null,
  asset: "BNB",
  category: "external",
  rawContract: { value: "0xd2a87d03f4f000", address: null, decimal: "0x12" },
  metadata: { blockTimestamp: "2026-10-23T15:49:28.000Z" },
};
const BNB = { chain: "bnb" as const, nativeSymbol: "BNB", nativeName: "BNB" };
const BASE = { chain: "base" as const, nativeSymbol: "ETH", nativeName: "Ether" };

type Call = { method: string; params: any[] } | { method: string; params: any[] }[];
/** A fake Alchemy endpoint: `answer` gets each parsed request body (single or batch). */
function alchemy(answer: (body: any) => unknown, calls: Call[] = [], status = 200): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    expect(url).toBe(RPC);
    const body = JSON.parse(String(init!.body));
    calls.push(body);
    if (!Array.isArray(body) && body.method === "eth_chainId") return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x38" }), { status: 200 });
    const res = answer(body);
    return new Response(typeof res === "string" ? res : JSON.stringify(res), { status });
  }) as unknown as typeof fetch;
}
const ok = (result: unknown) => ({ jsonrpc: "2.0", id: 1, result });
const make = (fetchImpl: typeof fetch, o: Partial<ConstructorParameters<typeof AlchemyProvider>[0]> = {}) =>
  new AlchemyProvider({ ...BNB, chainId: 56, rpcUrl: RPC, rpcEnv: "BNB_RPC_URL", fetchImpl, ...o });

describe("normalizeAlchemyTransfers", () => {
  it("reads base-unit amounts from rawContract (never the lossy float), with the same ids as the other EVM providers", () => {
    expect(normalizeAlchemyTransfers([erc20Row, externalRow] as any, BNB)).toEqual([
      {
        chain: "bnb",
        id: `${TX1}_132`,
        txHash: TX1,
        blockNumber: 0x7b5b46a,
        blockTime: Date.parse("2026-10-23T15:49:29Z") / 1000,
        from: ETH_B,
        to: ETH_A,
        fromOwner: null,
        toOwner: null,
        tokenId: WBNB,
        tokenSymbol: "WBNB",
        tokenName: null,
        tokenDecimals: 18,
        tokenStandard: "erc20",
        amountRaw: BigInt("0x2c801a94eafb7d9").toString(),
        priceCoin: `bsc:${WBNB}`,
      },
      expect.objectContaining({ id: `${TX2}_t0`, tokenId: "native", tokenSymbol: "BNB", tokenName: "BNB", tokenDecimals: 18, tokenStandard: "native", amountRaw: "59295000000000000", priceCoin: "coingecko:binancecoin" }),
    ]);
  });

  it("ERC-721, ERC-1155 (one row per token id in a batch) and internal calls, as Base serves them", () => {
    const h = `0x${"3".repeat(64)}`;
    const nft = "0x4857db576ee0e45f10525ec59527bfd10beec60b";
    const multi = "0x969c6ecf97c256846029cbcbb865824e505e006f";
    const rows = [
      { ...erc20Row, uniqueId: `${h}:log:1845`, hash: h, category: "erc721", asset: null, value: null, erc721TokenId: "0x" + "0".repeat(58) + "024f43", tokenId: "0x" + "0".repeat(58) + "024f43", rawContract: { value: null, address: nft, decimal: null } },
      { ...erc20Row, uniqueId: `${h}:log:1589`, hash: h, category: "erc1155", asset: null, value: null, erc1155Metadata: [{ tokenId: "0x00", value: "0x01" }, { tokenId: "0x07", value: "0x0" }, { tokenId: "0x08", value: "0x03" }], rawContract: { value: null, address: multi, decimal: null } },
      { ...externalRow, uniqueId: `${h}:internal:2_0_0_0_0_3_4_0`, hash: h, category: "internal", asset: "ETH", rawContract: { value: "0x3d81c30ddd6465", address: null, decimal: "0x12" } },
    ];
    const out = normalizeAlchemyTransfers(rows as any, BASE);
    expect(out.map((t) => [t.id, t.tokenStandard, t.tokenName, t.amountRaw, t.priceCoin])).toEqual([
      [`${h}_1845`, "erc721", "#151363", "1", null],
      [`${h}_1589`, "erc1155", "#0", "1", null],
      [`${h}_1589_1`, "erc1155", "#8", "3", null], // the zero-amount token id in between is skipped
      [`${h}_i2_0_0_0_0_3_4_0`, "native", "Ether", BigInt("0x3d81c30ddd6465").toString(), "coingecko:ethereum"],
    ]);
    expect(out.every((t) => t.chain === "base")).toBe(true);
  });

  it("drops rows it can't place or value instead of guessing: no timestamp, no counterparty, zero or missing amount, unknown category", () => {
    const rows = [
      { ...externalRow, metadata: null },
      { ...externalRow, to: null },
      { ...externalRow, rawContract: { value: "0x0", address: null, decimal: "0x12" } },
      { ...erc20Row, rawContract: { ...erc20Row.rawContract, value: null } },
      { ...erc20Row, category: "specialnft" },
    ];
    expect(normalizeAlchemyTransfers(rows as any, BNB)).toEqual([]);
    // An absurd decimals value from a token contract is unknown, not 10^huge.
    expect(normalizeAlchemyTransfers([{ ...erc20Row, rawContract: { ...erc20Row.rawContract, decimal: "0x1000" } }] as any, BNB)[0]!.tokenDecimals).toBeNull();
  });
});

describe("AlchemyProvider transfer history", () => {
  it("one stream per direction: toAddress for incoming, fromAddress for outgoing, newest first, every supported category", async () => {
    const calls: Call[] = [];
    const p = make(alchemy(() => ok({ transfers: [erc20Row], pageKey: "4fb62bc7-8457-405f-8caf-172340d93b7b" }), calls));
    expect(p.streams()).toEqual(["incoming", "outgoing"]);
    expect(p.id).toBe("alchemy-bnb");
    expect(p.name).toBe("Alchemy (BNB Chain)");
    const page = await p.fetchStreamPage(A, "incoming", null, budgetMs(5000));
    await p.fetchStreamPage(A, "outgoing", null, budgetMs(5000));
    const [chainId, inc, out] = calls as { method: string; params: any[] }[];
    expect(chainId!.method).toBe("eth_chainId");
    expect(inc).toMatchObject({ method: "alchemy_getAssetTransfers", params: [{ toAddress: ETH_A, order: "desc", withMetadata: true, excludeZeroValue: true, maxCount: "0x3e8", category: ["external", "erc20", "erc721", "erc1155"] }] });
    expect(inc!.params[0].fromAddress).toBeUndefined();
    expect(out!.params[0]).toMatchObject({ fromAddress: ETH_A });
    expect(out!.params[0].toAddress).toBeUndefined();
    expect(calls.filter((c: any) => c.method === "eth_chainId")).toHaveLength(1); // checked once, not per call
    expect(page.transfers).toHaveLength(1);
    expect(page.nextCursor).toBe(JSON.stringify({ k: "4fb62bc7-8457-405f-8caf-172340d93b7b", b: 0x7b5b46a }));
    expect(page.oldestTime).toBe(Date.parse("2026-10-23T15:49:29Z") / 1000);
  });

  it("asks for internal transfers only where Alchemy serves them (Base, not BNB or Robinhood Chain)", async () => {
    const calls: Call[] = [];
    const p = make(alchemy(() => ok({ transfers: [] }), calls), { internal: true });
    await p.fetchStreamPage(A, "incoming", null, budgetMs(5000));
    expect((calls[1] as any).params[0].category).toEqual(["external", "internal", "erc20", "erc721", "erc1155"]);
  });

  it("pages by pageKey, and falls back to the page's oldest block when Alchemy rejects a stored pageKey", async () => {
    const calls: Call[] = [];
    const p = make(alchemy(() => ok({ transfers: [externalRow], pageKey: null }), calls));
    // Alchemy answers a bad pageKey with HTTP 400 and a non-JSON-RPC body.
    const rejecting = make(
      (async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init!.body));
        calls.push(body);
        if (body.method === "eth_chainId") return new Response(JSON.stringify(ok("0x38")), { status: 200 });
        if (body.params[0].pageKey) return new Response(JSON.stringify({ error: "Invalid pageKey format for transfers. Expected UUID format." }), { status: 400 });
        return new Response(JSON.stringify(ok({ transfers: [externalRow] })), { status: 200 });
      }) as unknown as typeof fetch,
    );
    const next = await p.fetchStreamPage(A, "incoming", JSON.stringify({ k: "good-key", b: 100 }), budgetMs(5000));
    expect((calls.at(-1) as any).params[0]).toMatchObject({ pageKey: "good-key" });
    expect(next.nextCursor).toBeNull();
    const fallback = await rejecting.fetchStreamPage(A, "incoming", JSON.stringify({ k: "expired", b: 129348821 }), budgetMs(5000));
    const last = (calls.at(-1) as any).params[0];
    expect(last.pageKey).toBeUndefined();
    expect(last.toBlock).toBe("0x7b5b4d5");
    expect(fallback.transfers).toHaveLength(1);
    await expect(p.fetchStreamPage(A, "incoming", "not json", budgetMs(5000))).rejects.toBeInstanceOf(ProviderError);
  });

  it("fetchTransfers merges both directions and returns a self-transfer once", async () => {
    const self = { ...externalRow, from: A, to: A };
    const p = make(alchemy(() => ok({ transfers: [self, erc20Row] })));
    const r = await p.fetchTransfers(A, { budget: budgetMs(5000) });
    expect(r.transfers.map((t) => t.id)).toEqual([`${TX2}_t0`, `${TX1}_132`]);
    expect(r.nextCursor).toBeNull();
  });

  it("a genuinely empty history is empty; a failed request is a provider error, never an empty page", async () => {
    expect((await make(alchemy(() => ok({ transfers: [] }))).fetchStreamPage(A, "incoming", null, budgetMs(5000))).transfers).toEqual([]);
    const errReply = make(alchemy(() => ({ jsonrpc: "2.0", id: 1, result: null, error: { code: -32602, message: "The 'internal' category is not supported for this network." } })));
    const e1 = await errReply.fetchStreamPage(A, "incoming", null, budgetMs(5000)).catch((e) => e);
    expect(e1).toBeInstanceOf(ProviderError);
    expect(e1.message).toMatch(/^Alchemy alchemy_getAssetTransfers: The 'internal' category is not supported/);
    const e2 = await make(alchemy(() => "<html>bad gateway</html>", [], 502)).fetchStreamPage(A, "incoming", null, budgetMs(5000)).catch((e) => e);
    expect(e2).toBeInstanceOf(ProviderError);
    const e3 = await make(alchemy(() => ok({ nope: true }))).fetchStreamPage(A, "incoming", null, budgetMs(5000)).catch((e) => e);
    expect(e3.message).toMatch(/unexpected response/);
    for (const e of [e1, e2, e3]) expect(e.message).not.toContain("TESTKEY");
  });

  it("a non-Alchemy RPC (the zero-config public defaults) says what's missing instead of a vague failure", async () => {
    const methodMissing = make(alchemy(() => ({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "The method alchemy_getAssetTransfers does not exist/is not available" } })));
    const e1 = await methodMissing.fetchStreamPage(A, "incoming", null, budgetMs(5000)).catch((e) => e);
    expect(e1.message).toMatch(/BNB Chain address lookups need an Alchemy RPC URL with a valid key in BNB_RPC_URL/);
    // Base's public RPC refuses the method at the HTTP level instead.
    const filtered = make(alchemy(() => ({ jsonrpc: "2.0", id: 1, error: { code: -32611, message: "rejected due to request filter settings" } }), [], 401));
    const e2 = await filtered.fetchStreamPage(A, "incoming", null, budgetMs(5000)).catch((e) => e);
    expect(e2.message).toMatch(/need an Alchemy RPC URL .* \(HTTP 401\)/);
    expect((await filtered.ping()).ok).toBe(false);
  });

  it("refuses an RPC that answers for another chain: it would store that chain's rows as this one's", async () => {
    let dataCalls = 0;
    const wrongChain = (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      if (body.method === "eth_chainId") return new Response(JSON.stringify(ok("0x1")), { status: 200 });
      dataCalls++;
      return new Response(JSON.stringify(ok({ transfers: [externalRow] })), { status: 200 });
    }) as unknown as typeof fetch;
    const p = make(wrongChain);
    const err = await p.fetchStreamPage(A, "incoming", null, budgetMs(5000)).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe("BNB_RPC_URL answers for chain id 1, not BNB Chain's 56 -- check the URL");
    await expect(p.fetchBalances(A, budgetMs(5000))).rejects.toThrow(/chain id 1/);
    expect(dataCalls).toBe(0);
  });

  // Real Alchemy answer (BNB, 2026-10-23): MYX comes back with `rawContract.decimal: null` (and
  // alchemy_getTokenMetadata says `decimals: null` too), though the contract's own decimals() is 18.
  // Stored unscaled, that one ~$80 swap priced at $1.27e19 in the Tracer's counterparty table.
  const MYX = "0xD82544bf0dfe8385eF8FA34D67e6e4940CC63e16";
  const NO_DECIMALS = "0x1de460f363AF910f51726DEf188F9004276Bf4bc";
  const TX3 = "0x6b0b114648b379498f19e9640605660d1fb6a4a075c84bd1efc1a9aedaa46f84";
  const myxRow = { ...erc20Row, blockNum: "0x7b5c7c8", uniqueId: `${TX3}:log:387`, hash: TX3, value: null, asset: "MYX", rawContract: { value: "0xb0260c1b8697a8738", address: MYX.toLowerCase(), decimal: null } };
  const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

  it("reads decimals() on-chain for a token Alchemy has no decimals for, once per token, paired by id", async () => {
    const calls: Call[] = [];
    const noDecRow = { ...myxRow, uniqueId: `${TX3}:log:388`, asset: "X", rawContract: { ...myxRow.rawContract, address: NO_DECIMALS.toLowerCase() } };
    const p = make(
      alchemy((body) => {
        if (!Array.isArray(body)) return ok({ transfers: [myxRow, noDecRow, erc20Row] });
        // Answer out of order: MYX's decimals() is 18; the other contract reverts.
        return body
          .map((b: any) => (b.params[0].to === MYX ? { jsonrpc: "2.0", id: b.id, result: word(18) } : { jsonrpc: "2.0", id: b.id, error: { code: 3, message: "execution reverted" } }))
          .reverse();
      }, calls),
    );
    const page = await p.fetchStreamPage(A, "incoming", null, budgetMs(5000));
    const batch = calls.find((c) => Array.isArray(c)) as { method: string; params: any[] }[];
    // Only the tokens missing decimals are asked about (WBNB already came with 0x12).
    expect(batch.map((b) => [b.method, b.params[0].to, b.params[0].data])).toEqual([
      ["eth_call", MYX, "0x313ce567"],
      ["eth_call", toChecksumAddress(NO_DECIMALS), "0x313ce567"],
    ]);
    expect(page.transfers.map((t) => [t.tokenSymbol, t.tokenDecimals])).toEqual([["MYX", 18], ["X", null], ["WBNB", 18]]);
    // A second page with MYX again reuses the read; only the still-unknown token is asked again.
    await p.fetchStreamPage(A, "outgoing", null, budgetMs(5000));
    const second = calls.filter((c) => Array.isArray(c))[1] as { params: any[] }[];
    expect(second.map((b) => b.params[0].to)).toEqual([toChecksumAddress(NO_DECIMALS)]);
  });

  it("a failed decimals() batch leaves the token's decimals unknown but never fails the page", async () => {
    const p = make(alchemy((body) => (Array.isArray(body) ? "<html>bad gateway</html>" : ok({ transfers: [myxRow] }))));
    const page = await p.fetchStreamPage(A, "incoming", null, budgetMs(5000));
    expect(page.transfers).toHaveLength(1);
    expect(page.transfers[0]).toMatchObject({ tokenId: MYX, tokenDecimals: null, amountRaw: "203085534594432927544" });
  });
});

describe("AlchemyProvider balances", () => {
  const ZERO = "0x00000000000000000000000000000000000000aa";
  const BROKEN = "0x00000000000000000000000000000000000000bb";
  const UNNAMED = "0x00000000000000000000000000000000000000cc";
  const pad = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");

  it("native from eth_getBalance; ERC-20s from alchemy_getTokenBalances (every page), named by batched alchemy_getTokenMetadata paired by id", async () => {
    const calls: Call[] = [];
    const p = make(
      alchemy((b) => {
        if (Array.isArray(b)) {
          // Answered out of order, on purpose: results must be paired by id (LESSONS.md).
          const id = (c: string) => b.find((r: any) => r.params[0].toLowerCase() === c.toLowerCase()).id;
          return [
            { jsonrpc: "2.0", id: id(BASE_WETH), result: { decimals: 18, logo: "javascript:alert(1)", name: "Wrapped Ether", symbol: "WETH" } },
            { jsonrpc: "2.0", id: id(UNNAMED), error: { code: -32000, message: "execution reverted" } },
            { jsonrpc: "2.0", id: id(BASE_USDC), result: { decimals: 6, logo: "https://static.alchemyapi.io/images/assets/3408.png", name: "USD Coin", symbol: "USDC" } },
          ];
        }
        if (b.method === "eth_getBalance") return ok("0x16345785d8a0000");
        if (b.params[2]?.pageKey === "p2") return ok({ address: A, tokenBalances: [{ contractAddress: UNNAMED, tokenBalance: pad(5n) }] });
        return ok({
          address: A,
          tokenBalances: [
            { contractAddress: BASE_USDC.toLowerCase(), tokenBalance: pad(12_500_000n) },
            { contractAddress: ZERO, tokenBalance: pad(0n) },
            { contractAddress: BROKEN, tokenBalance: null, error: "execution reverted" },
            { contractAddress: BASE_WETH, tokenBalance: pad(3n * 10n ** 18n) },
          ],
          pageKey: "p2",
        });
      }, calls),
      BASE,
    );
    const out = await p.fetchBalances(A, budgetMs(5000));
    expect(out).toEqual([
      { tokenId: "native", symbol: "ETH", name: "Ether", decimals: 18, amountRaw: "100000000000000000", priceCoin: "coingecko:ethereum" },
      { tokenId: BASE_USDC, symbol: "USDC", name: "USD Coin", decimals: 6, amountRaw: "12500000", priceCoin: `base:${BASE_USDC}`, logoUrl: "https://static.alchemyapi.io/images/assets/3408.png" },
      { tokenId: BASE_WETH, symbol: "WETH", name: "Wrapped Ether", decimals: 18, amountRaw: "3000000000000000000", priceCoin: `base:${BASE_WETH}`, logoUrl: null },
      // Its metadata call failed: the balance is still real, just unnamed (the route falls back to DefiLlama's).
      { tokenId: toChecksumAddress(UNNAMED), symbol: null, name: null, decimals: null, amountRaw: "5", priceCoin: `base:${toChecksumAddress(UNNAMED)}`, logoUrl: null },
    ]);
    const single = calls.filter((c): c is { method: string; params: any[] } => !Array.isArray(c));
    expect(single.find((c) => c.method === "eth_getBalance")!.params).toEqual([ETH_A, "latest"]);
    expect(single.filter((c) => c.method === "alchemy_getTokenBalances").map((c) => c.params)).toEqual([[ETH_A, "erc20"], [ETH_A, "erc20", { pageKey: "p2" }]]);
    // Only the non-zero holdings are looked up, in one batch.
    const batch = calls.find(Array.isArray)!;
    expect(batch.map((r) => r.method)).toEqual(["alchemy_getTokenMetadata", "alchemy_getTokenMetadata", "alchemy_getTokenMetadata"]);
  });

  it("an empty wallet is empty; a failed token-balance or metadata request throws rather than show a token-less wallet", async () => {
    const empty = make(alchemy((b) => (b.method === "eth_getBalance" ? ok("0x0") : ok({ address: A, tokenBalances: [] }))));
    expect(await empty.fetchBalances(A, budgetMs(5000))).toEqual([]);
    const tokensFail = make(alchemy((b) => (b.method === "eth_getBalance" ? ok("0x1") : { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "upstream timeout" } })));
    await expect(tokensFail.fetchBalances(A, budgetMs(5000))).rejects.toThrow(/Alchemy alchemy_getTokenBalances: upstream timeout/);
    const metaFail = make(
      alchemy((b) => {
        if (Array.isArray(b)) return { jsonrpc: "2.0", error: { code: -32600, message: "batch too large" } };
        return b.method === "eth_getBalance" ? ok("0x1") : ok({ address: A, tokenBalances: [{ contractAddress: BASE_USDC, tokenBalance: pad(1n) }] });
      }),
    );
    await expect(metaFail.fetchBalances(A, budgetMs(5000))).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("AlchemyProvider ping", () => {
  it("re-checks the chain id every time but proves the enhanced API only once (the health route pings every minute)", async () => {
    const calls: Call[] = [];
    const p = make(alchemy(() => ok({ transfers: [] }), calls));
    expect(await p.ping()).toEqual({ ok: true });
    expect(await p.ping()).toEqual({ ok: true });
    expect(calls.map((c: any) => c.method)).toEqual(["eth_chainId", "alchemy_getAssetTransfers", "eth_chainId"]);
  });
});
