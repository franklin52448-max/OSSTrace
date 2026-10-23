// Arbitrum One, OP Mainnet, Zora, Lens Chain and the Data Network (chain id "story", formerly Story),
// then Gnosis Chain, Ronin and Rootstock, then ZetaChain, Mythos and the HyperEVM ("hyperliquid"): eleven
// more EVM chains, each read through the same
// AlchemyProvider as BNB Chain / Robinhood Chain / Base (chain/alchemy.ts, tested in alchemy.test.ts) on
// its own RPC URL. Each block below runs once per chain, the same checks base.test.ts makes for Base.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { AlchemyProvider } from "../src/chain/alchemy.ts";
import { TransferStore } from "../src/chain/store.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { budgetMs } from "../src/lib/http.ts";
import { alchemyFetch, ETH_A, ETH_B, ETH_C, ethTransfer, makeApp, signup, SOL_A, type Client, type TestApp } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));

type NewChain = keyof TestApp["more"];
type Case = {
  chain: NewChain;
  name: string;
  chainId: number;
  env: string;
  configKey: keyof Config & `${string}RpcUrl`;
  defaultRpc: string;
  nativeSymbol: string;
  nativeName: string;
  nativeCoin: string;
  llamaPrefix: string;
  /** A real token contract on that chain, for the pricing-key check. */
  token: string;
};

const CASES: Case[] = [
  {
    chain: "arbitrum",
    name: "Arbitrum One",
    chainId: 42161,
    env: "ARBITRUM_RPC_URL",
    configKey: "arbitrumRpcUrl",
    defaultRpc: "https://arb1.arbitrum.io/rpc",
    nativeSymbol: "ETH",
    nativeName: "Ether",
    nativeCoin: "coingecko:ethereum",
    llamaPrefix: "arbitrum",
    token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // Circle USDC
  },
  {
    chain: "optimism",
    name: "OP Mainnet",
    chainId: 10,
    env: "OPTIMISM_RPC_URL",
    configKey: "optimismRpcUrl",
    defaultRpc: "https://mainnet.optimism.io",
    nativeSymbol: "ETH",
    nativeName: "Ether",
    nativeCoin: "coingecko:ethereum",
    llamaPrefix: "optimism",
    token: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", // Circle USDC
  },
  {
    chain: "zora",
    name: "Zora",
    chainId: 7777777,
    env: "ZORA_RPC_URL",
    configKey: "zoraRpcUrl",
    defaultRpc: "https://rpc.zora.energy",
    nativeSymbol: "ETH",
    nativeName: "Ether",
    nativeCoin: "coingecko:ethereum",
    llamaPrefix: "zora",
    token: "0x4200000000000000000000000000000000000006", // WETH
  },
  {
    chain: "lens",
    name: "Lens Chain",
    chainId: 232,
    env: "LENS_RPC_URL",
    configKey: "lensRpcUrl",
    defaultRpc: "https://rpc.lens.xyz",
    nativeSymbol: "GHO",
    nativeName: "GHO",
    nativeCoin: "coingecko:gho",
    llamaPrefix: "lens",
    token: "0x6bDc36E20D267Ff0dd6097799f82e78907105e2F", // WGHO
  },
  {
    chain: "story",
    name: "Data Network",
    chainId: 1514,
    env: "STORY_RPC_URL",
    configKey: "storyRpcUrl",
    defaultRpc: "https://mainnet.datarpc.io",
    nativeSymbol: "DATA",
    nativeName: "DATA",
    nativeCoin: "coingecko:story-2",
    llamaPrefix: "sty",
    token: "0x1514000000000000000000000000000000000000", // WIP (wrapped native)
  },
  {
    chain: "gnosis",
    name: "Gnosis Chain",
    chainId: 100,
    env: "GNOSIS_RPC_URL",
    configKey: "gnosisRpcUrl",
    defaultRpc: "https://rpc.gnosischain.com",
    nativeSymbol: "xDAI",
    nativeName: "xDAI",
    nativeCoin: "coingecko:xdai",
    llamaPrefix: "xdai",
    token: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d", // WXDAI
  },
  {
    chain: "ronin",
    name: "Ronin",
    chainId: 2020,
    env: "RONIN_RPC_URL",
    configKey: "roninRpcUrl",
    defaultRpc: "https://api.roninchain.com/rpc",
    nativeSymbol: "RON",
    nativeName: "Ronin",
    nativeCoin: "coingecko:ronin",
    llamaPrefix: "ronin",
    token: "0xe514d9DEB7966c8BE0ca922de8a064264eA6bcd4", // WRON
  },
  {
    chain: "rootstock",
    name: "Rootstock",
    chainId: 30,
    env: "ROOTSTOCK_RPC_URL",
    configKey: "rootstockRpcUrl",
    defaultRpc: "https://public-node.rsk.co",
    nativeSymbol: "RBTC",
    nativeName: "Smart Bitcoin",
    nativeCoin: "coingecko:rootstock",
    llamaPrefix: "rsk",
    token: "0x542fDA317318eBF1d3DEAf76E0b632741A7e677d", // WRBTC
  },
  {
    chain: "zetachain",
    name: "ZetaChain",
    chainId: 7000,
    env: "ZETACHAIN_RPC_URL",
    configKey: "zetachainRpcUrl",
    defaultRpc: "https://zetachain-evm.blockpi.network/v1/rpc/public",
    nativeSymbol: "ZETA",
    nativeName: "Zeta",
    nativeCoin: "coingecko:zetachain",
    llamaPrefix: "zeta",
    token: "0x5F0b1a82749cb4E2278EC87F8BF6B618dC71a8bf", // WZETA
  },
  {
    // Gas is ETH here, not MYTH (the ecosystem token): an OP Stack chain with no custom gas token.
    chain: "mythos",
    name: "Mythos",
    chainId: 42018,
    env: "MYTHOS_RPC_URL",
    configKey: "mythosRpcUrl",
    defaultRpc: "https://mythos-mainnet.g.alchemy.com/public",
    nativeSymbol: "ETH",
    nativeName: "Ether",
    nativeCoin: "coingecko:ethereum",
    llamaPrefix: "mythos",
    token: "0x4200000000000000000000000000000000000006", // WETH (OP Stack predeploy)
  },
  {
    chain: "hyperliquid",
    name: "HyperEVM",
    chainId: 999,
    env: "HYPERLIQUID_RPC_URL",
    configKey: "hyperliquidRpcUrl",
    defaultRpc: "https://rpc.hyperliquid.xyz/evm",
    nativeSymbol: "HYPE",
    nativeName: "HYPE",
    nativeCoin: "coingecko:hyperliquid",
    llamaPrefix: "hyperliquid",
    token: "0x5555555555555555555555555555555555555555", // WHYPE
  },
];

describe.each(CASES)("$name provider wiring", (k) => {
  it(`buildApp reads ${k.name} through AlchemyProvider on ${k.env}, checked against chain id ${k.chainId}, no internal transfers`, async () => {
    const url = `https://${k.chain}-mainnet.g.alchemy.test/v2/k`;
    const config = { ...loadConfig({ NODE_ENV: "test", [k.env]: url } as NodeJS.ProcessEnv), dbPath: ":memory:" };
    const urls: string[] = [];
    const bodies: any[] = [];
    const inner = alchemyFetch(`0x${k.chainId.toString(16)}`, urls);
    const fetchImpl = (async (u: string, init?: RequestInit) => (bodies.push(JSON.parse(String(init!.body))), inner(u, init))) as unknown as typeof fetch;
    const { app, ctx } = await buildApp(config, { db: openDb(":memory:"), fetchImpl, logger: false });
    try {
      const p = ctx.providers[k.chain];
      expect(p).toBeInstanceOf(AlchemyProvider);
      expect(p).toMatchObject({ chain: k.chain, id: `alchemy-${k.chain}`, name: `Alchemy (${k.name})` });
      const page = await p.fetchStreamPage(ETH_A, "incoming", null, budgetMs(5000));
      expect(page.transfers[0]).toMatchObject({ chain: k.chain, to: ETH_A, tokenId: "native", tokenSymbol: k.nativeSymbol, tokenName: k.nativeName, priceCoin: k.nativeCoin });
      expect(urls.length).toBeGreaterThan(0);
      expect(urls.every((u) => u === url)).toBe(true);
      expect(bodies.find((b) => b.method === "eth_chainId")).toBeDefined();
      // Alchemy answers -32602 for the internal category on all eleven (checked live 2026-10-23).
      expect(bodies.find((b) => b.method === "alchemy_getAssetTransfers").params[0].category).toEqual(["external", "erc20", "erc721", "erc1155"]);
    } finally {
      await app.close();
    }
  });

  it(`refuses an ${k.env} that answers for another chain`, async () => {
    const config = { ...loadConfig({ NODE_ENV: "test", [k.env]: "https://wrong.example/v2/k" } as NodeJS.ProcessEnv), dbPath: ":memory:" };
    const { app, ctx } = await buildApp(config, { db: openDb(":memory:"), fetchImpl: alchemyFetch("0x1"), logger: false });
    try {
      const err = await ctx.providers[k.chain].fetchStreamPage(ETH_A, "incoming", null, budgetMs(5000)).catch((e) => e);
      expect(err.message).toBe(`${k.env} answers for chain id 1, not ${k.name}'s ${k.chainId} -- check the URL`);
    } finally {
      await app.close();
    }
  });
});

describe("Lens Chain wiring: no double-counted native transfers, real block times", () => {
  it("drops the L2BaseToken (0x...800a) mirror rows and reads missing block times from the block", async () => {
    const hash = `0x${"4c".repeat(32)}`;
    const ext = { blockNum: "0x61e65d", uniqueId: `${hash}:external`, hash, from: ETH_B.toLowerCase(), to: ETH_A.toLowerCase(), value: 0.5, erc721TokenId: null, erc1155Metadata: null, tokenId: null, asset: "ETH", category: "external", rawContract: { value: "0x06f05b59d3b20000", address: null, decimal: "0x12" }, metadata: null };
    const mirror = { ...ext, uniqueId: `${hash}:log:2`, category: "erc20", asset: null, rawContract: { value: "0x6f05b59d3b20000", address: "0x000000000000000000000000000000000000800a", decimal: null } };
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      const reply = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
      if (Array.isArray(body)) return reply(body.map((b: any) => ({ jsonrpc: "2.0", id: b.id, result: { timestamp: "0x6adb8abc" } })));
      if (body.method === "eth_chainId") return reply({ jsonrpc: "2.0", id: body.id, result: "0xe8" });
      return reply({ jsonrpc: "2.0", id: body.id, result: { transfers: [ext, mirror] } });
    }) as unknown as typeof fetch;
    const config = { ...loadConfig({ NODE_ENV: "test", LENS_RPC_URL: "https://lens-mainnet.g.alchemy.test/v2/k" } as NodeJS.ProcessEnv), dbPath: ":memory:" };
    const { app, ctx } = await buildApp(config, { db: openDb(":memory:"), fetchImpl, logger: false });
    try {
      const page = await ctx.providers.lens.fetchStreamPage(ETH_A, "incoming", null, budgetMs(5000));
      expect(page.transfers).toEqual([expect.objectContaining({ chain: "lens", id: `${hash}_t0`, tokenSymbol: "GHO", amountRaw: "500000000000000000", blockTime: 0x6adb8abc })]);
    } finally {
      await app.close();
    }
  });
});

describe("Rootstock wiring: real block times where Alchemy leaves them out", () => {
  it("reads each row's block time from its block (Alchemy answers metadata: null on Rootstock), never drops the row", async () => {
    const hash = `0x${"3b".repeat(32)}`;
    const ext = { blockNum: "0x8eacfe", uniqueId: `${hash}:external`, hash, from: ETH_B.toLowerCase(), to: ETH_A.toLowerCase(), value: 0.001, erc721TokenId: null, erc1155Metadata: null, tokenId: null, asset: "RBTC", category: "external", rawContract: { value: "0x38d7ea4c68000", address: null, decimal: "0x12" }, metadata: null };
    const blocks: string[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      const reply = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
      if (Array.isArray(body)) return reply(body.map((b: any) => (blocks.push(b.params[0]), { jsonrpc: "2.0", id: b.id, result: { timestamp: "0x6adb8abc" } })));
      if (body.method === "eth_chainId") return reply({ jsonrpc: "2.0", id: body.id, result: "0x1e" });
      return reply({ jsonrpc: "2.0", id: body.id, result: { transfers: [ext] } });
    }) as unknown as typeof fetch;
    const config = { ...loadConfig({ NODE_ENV: "test", ROOTSTOCK_RPC_URL: "https://rootstock-mainnet.g.alchemy.test/v2/k" } as NodeJS.ProcessEnv), dbPath: ":memory:" };
    const { app, ctx } = await buildApp(config, { db: openDb(":memory:"), fetchImpl, logger: false });
    try {
      const page = await ctx.providers.rootstock.fetchStreamPage(ETH_A, "incoming", null, budgetMs(5000));
      expect(page.transfers).toEqual([expect.objectContaining({ chain: "rootstock", id: `${hash}_t0`, tokenId: "native", tokenSymbol: "RBTC", amountRaw: "1000000000000000", blockTime: 0x6adb8abc, priceCoin: "coingecko:rootstock" })]);
      expect(blocks).toEqual(["0x8eacfe"]);
    } finally {
      await app.close();
    }
  });
});

// ZetaChain, Mythos and the HyperEVM: Alchemy answers every row with metadata: null on all three, even
// with withMetadata: true (checked live 2026-10-23), so each row's block time comes from its block.
const NULL_METADATA_CASES = [
  { chain: "zetachain", chainIdHex: "0x1b58", asset: "ETH", symbol: "ZETA", coin: "coingecko:zetachain" },
  { chain: "mythos", chainIdHex: "0xa422", asset: "ETH", symbol: "ETH", coin: "coingecko:ethereum" },
  { chain: "hyperliquid", chainIdHex: "0x3e7", asset: "ETH", symbol: "HYPE", coin: "coingecko:hyperliquid" },
] as const;

describe.each(NULL_METADATA_CASES)("$chain wiring: real block times where Alchemy leaves them out, the chain's own native symbol", (k) => {
  it("reads the row's block time from its block and names the native unit by the chain, not Alchemy's generic asset label", async () => {
    const hash = `0x${"5d".repeat(32)}`;
    // Alchemy labels every native row "ETH" on all three -- the provider names it by the chain instead.
    const ext = { blockNum: "0x12c86a3", uniqueId: `${hash}:external`, hash, from: ETH_B.toLowerCase(), to: ETH_A.toLowerCase(), value: 0.5, erc721TokenId: null, erc1155Metadata: null, tokenId: null, asset: k.asset, category: "external", rawContract: { value: "0x6f05b59d3b20000", address: null, decimal: "0x12" }, metadata: null };
    const blocks: string[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      const reply = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
      if (Array.isArray(body)) return reply(body.map((b: any) => (blocks.push(b.params[0]), { jsonrpc: "2.0", id: b.id, result: { timestamp: "0x6adb8abc" } })));
      if (body.method === "eth_chainId") return reply({ jsonrpc: "2.0", id: body.id, result: k.chainIdHex });
      return reply({ jsonrpc: "2.0", id: body.id, result: { transfers: [ext] } });
    }) as unknown as typeof fetch;
    const env = `${k.chain.toUpperCase()}_RPC_URL`;
    const config = { ...loadConfig({ NODE_ENV: "test", [env]: `https://${k.chain}-mainnet.g.alchemy.test/v2/k` } as NodeJS.ProcessEnv), dbPath: ":memory:" };
    const { app, ctx } = await buildApp(config, { db: openDb(":memory:"), fetchImpl, logger: false });
    try {
      const page = await ctx.providers[k.chain].fetchStreamPage(ETH_A, "incoming", null, budgetMs(5000));
      expect(page.transfers).toEqual([expect.objectContaining({ chain: k.chain, id: `${hash}_t0`, tokenId: "native", tokenSymbol: k.symbol, amountRaw: "500000000000000000", blockTime: 0x6adb8abc, priceCoin: k.coin })]);
      expect(blocks).toEqual(["0x12c86a3"]);
    } finally {
      await app.close();
    }
  });
});

describe("Mythos: ETH gas, never Ethereum's rows or MYTH's price", () => {
  it("a native Mythos transfer says ETH, priced off ether's series, while its tokens never borrow another chain's DefiLlama key", () => {
    expect(TransferStore.coinFor({ chain: "mythos", token_id: "native", token_standard: "native" })).toBe("coingecko:ethereum");
    const weth = "0x4200000000000000000000000000000000000006";
    // The same predeploy address exists on every OP Stack chain: Mythos's must never price as OP Mainnet's or Base's.
    expect(TransferStore.coinFor({ chain: "mythos", token_id: weth, token_standard: "erc20" })).toBe(`mythos:${weth}`);
    expect(TransferStore.coinFor({ chain: "optimism", token_id: weth, token_standard: "erc20" })).toBe(`optimism:${weth}`);
  });
});

describe.each(CASES)("$name config", (k) => {
  it("zero-config defaults to the chain's own public RPC (lookups need it to be an Alchemy URL), overridable by URL or file", () => {
    expect(loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv)[k.configKey]).toBe(k.defaultRpc);
    expect(loadConfig({ NODE_ENV: "test", [k.env]: " https://rpc.example/x " } as NodeJS.ProcessEnv)[k.configKey]).toBe("https://rpc.example/x");
    expect(loadConfig({ NODE_ENV: "test", [k.env]: "" } as NodeJS.ProcessEnv)[k.configKey]).toBe(k.defaultRpc);
    const dir = mkdtempSync(join(tmpdir(), "osstrace-rpc-"));
    try {
      const file = join(dir, "url");
      writeFileSync(file, "https://from-file.example/v2/secret\n");
      expect(loadConfig({ NODE_ENV: "test", [`${k.env}_FILE`]: file, [k.env]: "https://ignored.example" } as NodeJS.ProcessEnv)[k.configKey]).toBe("https://from-file.example/v2/secret");
      writeFileSync(file, "not a url");
      expect(() => loadConfig({ NODE_ENV: "test", [`${k.env}_FILE`]: file } as NodeJS.ProcessEnv)).toThrow(`${k.env}_FILE does not contain an http(s) URL`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.each(CASES)("$name as a first-class chain", (k) => {
  let t: TestApp;
  let c: Client;
  const at = Math.floor(Date.now() / 1000) - 86400;
  const onChain = (from: string, to: string, blockTime: number) => ethTransfer(from, to, blockTime, { chain: k.chain, tokenSymbol: k.nativeSymbol, tokenName: k.nativeName, priceCoin: k.nativeCoin });
  beforeEach(async () => {
    t = await makeApp();
    c = await signup(t.app, `${k.chain}-analyst`);
  });
  afterEach(async () => t.close());

  it("transfers and counterparties come from this chain's provider, never Ethereum's", async () => {
    t.more[k.chain].add([onChain(ETH_B, ETH_A, at), onChain(ETH_A, ETH_C, at + 1)]);
    t.eth.add([ethTransfer(ETH_B, ETH_A, at + 2)]);
    const r = (await c.get(`/api/transfers?base=${k.chain}:${ETH_A.toLowerCase()}&limit=50&timeLast=7d`)).json();
    expect(r.transfers).toHaveLength(2);
    expect(r.transfers.every((x: { chain: string; tokenSymbol: string }) => x.chain === k.chain && x.tokenSymbol === k.nativeSymbol)).toBe(true);
    expect(r.sync.provider).toBe(`Fake ${k.chain}`);
    const cps = (await c.get(`/api/address/${k.chain}/${ETH_A}/counterparties?flow=all`)).json();
    expect(cps.counterparties.map((x: { chains: string[] }) => x.chains)).toEqual([[k.chain], [k.chain]]);
    // A bare 0x ref with chain=<this chain> is this chain's account.
    expect((await c.get(`/api/transfers?base=${ETH_A}&chain=${k.chain}&limit=50&timeLast=7d`)).json().transfers).toHaveLength(2);
    // The same 0x address on Ethereum is its own account with its own history.
    const eth = (await c.get(`/api/transfers?base=ethereum:${ETH_A}&limit=50&timeLast=7d`)).json();
    expect(eth.transfers.map((x: { chain: string }) => x.chain)).toEqual(["ethereum"]);
  });

  it("address lookups take EVM addresses only; balances read this chain's provider", async () => {
    expect((await c.get(`/api/address/${k.chain}/${SOL_A}`)).statusCode).toBe(400);
    expect((await c.get(`/api/address/${k.chain}/${ETH_A.toLowerCase()}`)).json()).toMatchObject({ chain: k.chain, address: ETH_A });
    t.more[k.chain].balances = [{ tokenId: "native", symbol: k.nativeSymbol, name: k.nativeName, decimals: 18, amountRaw: "1500000000000000000", priceCoin: k.nativeCoin }];
    const r = (await c.get(`/api/address/${k.chain}/${ETH_A}/balances`)).json();
    expect(r.address).toMatchObject({ chain: k.chain, address: ETH_A });
    expect(r.balances).toEqual([expect.objectContaining({ tokenId: "native", symbol: k.nativeSymbol, amount: "1.5", usd: 3000 })]);
  });

  it(`prices native ${k.nativeSymbol} as ${k.nativeCoin} and tokens under DefiLlama's own ${k.llamaPrefix}: prefix`, () => {
    expect(TransferStore.coinFor({ chain: k.chain, token_id: "native", token_standard: "native" })).toBe(k.nativeCoin);
    expect(TransferStore.coinFor({ chain: k.chain, token_id: k.token, token_standard: "erc20" })).toBe(`${k.llamaPrefix}:${k.token}`);
    expect(TransferStore.coinFor({ chain: k.chain, token_id: k.token, token_standard: "erc721" })).toBeNull();
  });

  it("labels: its own row next to the same address's Ethereum label, and through CSV import/export", async () => {
    expect((await c.post("/api/labels", { chain: k.chain, address: ETH_A.toLowerCase(), name: `${k.name} wallet` })).statusCode).toBe(201);
    expect((await c.post("/api/labels", { chain: "ethereum", address: ETH_A, name: "Eth wallet" })).statusCode).toBe(201);
    expect((await c.post("/api/labels", { chain: k.chain, address: SOL_A, name: "nope" })).statusCode).toBe(400);
    expect((await c.get(`/api/address/${k.chain}/${ETH_A}`)).json()).toMatchObject({ label: { name: `${k.name} wallet` } });
    expect((await c.get(`/api/address/ethereum/${ETH_A}`)).json()).toMatchObject({ label: { name: "Eth wallet" } });
    const imp = (await c.post("/api/labels/import", { format: "csv", data: `chain,address,name\n${k.chain},${ETH_B},Imported`, onConflict: "skip" })).json();
    expect(imp.created).toBe(1);
    expect((await c.get("/api/labels/export?format=csv")).body).toContain(`${k.chain},${ETH_B},Imported`);
  });

  it("traces accept its address nodes; health lists it under its display name", async () => {
    const tr = await c.post("/api/traces", { initialAddress: ETH_A.toLowerCase(), initialChain: k.chain });
    expect(tr.statusCode).toBe(201);
    expect((await c.get(`/api/traces/${tr.json().id}`)).json().nodes).toEqual([expect.objectContaining({ kind: "address", chain: k.chain, address: ETH_A })]);
    expect((await c.post("/api/traces", { initialAddress: SOL_A, initialChain: k.chain })).statusCode).toBe(400);
    const h = (await c.get("/api/health")).json();
    expect(h.chains.find((x: { id: string }) => x.id === k.chain)).toMatchObject({ id: k.chain, name: k.name, provider: `Fake ${k.chain}`, ok: true });
  });
});

describe("migration 015 (labels.chain CHECK widened to the five new EVM chains)", () => {
  it("keeps every existing label -- including earlier chains' -- and its tag links, and now accepts each new chain", async () => {
    const t = await makeApp();
    try {
      const c = await signup(t.app, "migrator");
      const tag = (await c.post("/api/tags", { name: "keep", color: "#123456" })).json();
      const lab = (await c.post("/api/labels", { chain: "ethereum", address: ETH_A, name: "Before", tagIds: [tag.id] })).json();
      expect((await c.post("/api/labels", { chain: "base", address: ETH_B, name: "On Base" })).statusCode).toBe(201);
      expect((await c.post("/api/labels", { chain: "arbitrum", address: ETH_C, name: "On Arbitrum" })).statusCode).toBe(201);
      // Re-run the migration's own SQL against a database that already has data in it.
      t.ctx.db.tx(() => t.ctx.db.exec(readFileSync(join(here, "../src/db/migrations/015_labels_more_evm_chains.sql"), "utf8")));
      expect(t.ctx.db.all("SELECT label_id, tag_id FROM label_tags")).toEqual([{ label_id: lab.id, tag_id: tag.id }]);
      expect(t.ctx.db.all("SELECT chain, name FROM labels ORDER BY name")).toEqual([
        { chain: "ethereum", name: "Before" },
        { chain: "arbitrum", name: "On Arbitrum" },
        { chain: "base", name: "On Base" },
      ]);
      for (const chain of ["optimism", "zora", "lens", "story"]) expect((await c.post("/api/labels", { chain, address: ETH_A, name: `After ${chain}` })).statusCode).toBe(201);
      expect(() => t.ctx.db.run("UPDATE labels SET chain = 'bitcoin' WHERE id = ?", lab.id)).toThrow(/CHECK constraint failed/);
      expect(() => t.ctx.db.run("UPDATE labels SET chain = 'data' WHERE id = ?", lab.id)).toThrow(/CHECK constraint failed/);
    } finally {
      await t.close();
    }
  });
});

describe("migration 017 (labels.chain CHECK widened to Gnosis Chain, Ronin and Rootstock)", () => {
  it("keeps every existing label -- including the 015 chains' -- and its tag links, and now accepts each new chain", async () => {
    const t = await makeApp();
    try {
      const c = await signup(t.app, "migrator-017");
      const tag = (await c.post("/api/tags", { name: "keep", color: "#123456" })).json();
      const lab = (await c.post("/api/labels", { chain: "ethereum", address: ETH_A, name: "Before", tagIds: [tag.id] })).json();
      expect((await c.post("/api/labels", { chain: "story", address: ETH_B, name: "On Data Network" })).statusCode).toBe(201);
      expect((await c.post("/api/labels", { chain: "gnosis", address: ETH_C, name: "On Gnosis" })).statusCode).toBe(201);
      // Re-run the migration's own SQL against a database that already has data in it.
      t.ctx.db.tx(() => t.ctx.db.exec(readFileSync(join(here, "../src/db/migrations/017_labels_gnosis_ronin_rootstock.sql"), "utf8")));
      expect(t.ctx.db.all("SELECT label_id, tag_id FROM label_tags")).toEqual([{ label_id: lab.id, tag_id: tag.id }]);
      expect(t.ctx.db.all("SELECT chain, name FROM labels ORDER BY name")).toEqual([
        { chain: "ethereum", name: "Before" },
        { chain: "story", name: "On Data Network" },
        { chain: "gnosis", name: "On Gnosis" },
      ]);
      for (const chain of ["ronin", "rootstock"]) expect((await c.post("/api/labels", { chain, address: ETH_A, name: `After ${chain}` })).statusCode).toBe(201);
      expect(() => t.ctx.db.run("UPDATE labels SET chain = 'bitcoin' WHERE id = ?", lab.id)).toThrow(/CHECK constraint failed/);
      expect(() => t.ctx.db.run("UPDATE labels SET chain = 'rsk' WHERE id = ?", lab.id)).toThrow(/CHECK constraint failed/);
      expect(() => t.ctx.db.run("UPDATE labels SET chain = 'xdai' WHERE id = ?", lab.id)).toThrow(/CHECK constraint failed/);
    } finally {
      await t.close();
    }
  });
});

describe("migration 019 (labels.chain CHECK widened to ZetaChain, Mythos and the HyperEVM)", () => {
  it("keeps every existing label -- including the 017 chains' -- and its tag links, and now accepts each new chain", async () => {
    const t = await makeApp();
    try {
      const c = await signup(t.app, "migrator-019");
      const tag = (await c.post("/api/tags", { name: "keep", color: "#123456" })).json();
      const lab = (await c.post("/api/labels", { chain: "ethereum", address: ETH_A, name: "Before", tagIds: [tag.id] })).json();
      expect((await c.post("/api/labels", { chain: "rootstock", address: ETH_B, name: "On Rootstock" })).statusCode).toBe(201);
      expect((await c.post("/api/labels", { chain: "zetachain", address: ETH_C, name: "On ZetaChain" })).statusCode).toBe(201);
      // Re-run the migration's own SQL against a database that already has data in it.
      t.ctx.db.tx(() => t.ctx.db.exec(readFileSync(join(here, "../src/db/migrations/019_labels_zetachain_mythos_hyperliquid.sql"), "utf8")));
      expect(t.ctx.db.all("SELECT label_id, tag_id FROM label_tags")).toEqual([{ label_id: lab.id, tag_id: tag.id }]);
      expect(t.ctx.db.all("SELECT chain, name FROM labels ORDER BY name")).toEqual([
        { chain: "ethereum", name: "Before" },
        { chain: "rootstock", name: "On Rootstock" },
        { chain: "zetachain", name: "On ZetaChain" },
      ]);
      for (const chain of ["mythos", "hyperliquid"]) expect((await c.post("/api/labels", { chain, address: ETH_A, name: `After ${chain}` })).statusCode).toBe(201);
      expect(() => t.ctx.db.run("UPDATE labels SET chain = 'bitcoin' WHERE id = ?", lab.id)).toThrow(/CHECK constraint failed/);
      for (const alias of ["zeta", "hyperevm", "hype", "myth"]) expect(() => t.ctx.db.run("UPDATE labels SET chain = ? WHERE id = ?", alias, lab.id)).toThrow(/CHECK constraint failed/);
    } finally {
      await t.close();
    }
  });
});
