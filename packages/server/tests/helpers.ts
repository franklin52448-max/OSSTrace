import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import nacl from "tweetnacl";
import bs58 from "bs58";
import type { Chain } from "@osstrace/contract";
import { buildApp } from "../src/app.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { PriceService } from "../src/chain/prices.ts";
import { ProviderError } from "../src/lib/errors.ts";
import type { Budget } from "../src/lib/http.ts";
import type { ChainProvider, RawBalance, RawTransfer, StreamPage } from "../src/chain/types.ts";
import { combinedFetch } from "../src/chain/types.ts";
import type { WebhookSender } from "../src/context.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const fixture = <T = any>(path: string): T => JSON.parse(readFileSync(join(here, "fixtures", path), "utf8")).response as T;

export const ORIGIN = "http://127.0.0.1:5301";

/** Deterministic in-memory provider: transfers newest-first per stream, offset cursors. */
export class FakeProvider implements ChainProvider {
  readonly id: string;
  readonly name: string;
  data: Record<string, RawTransfer[]> = {};
  pageSize = 5;
  fail: ProviderError | null = null;
  calls = 0;
  constructor(
    readonly chain: Chain,
    private readonly streamNames: string[] = ["main"],
  ) {
    this.id = `fake-${chain}`;
    this.name = `Fake ${chain}`;
    for (const s of streamNames) this.data[s] = [];
  }
  streams() {
    return this.streamNames;
  }
  /** Adds transfers to a stream (kept newest-first). */
  add(ts: RawTransfer[], stream = this.streamNames[0]!) {
    this.data[stream] = [...this.data[stream]!, ...ts].sort((a, b) => b.blockTime - a.blockTime || b.id.localeCompare(a.id));
  }
  async fetchStreamPage(address: string, stream: string, cursor: string | null, _b: Budget): Promise<StreamPage> {
    this.calls++;
    if (this.fail) throw this.fail;
    const all = this.data[stream]!.filter((t) => t.from === address || t.to === address || t.fromOwner === address || t.toOwner === address);
    const off = cursor ? Number(cursor) : 0;
    const items = all.slice(off, off + this.pageSize);
    const next = off + this.pageSize < all.length ? String(off + this.pageSize) : null;
    const times = items.map((t) => t.blockTime);
    return { transfers: items, nextCursor: next, oldestTime: times.length ? Math.min(...times) : null, newestTime: times.length ? Math.max(...times) : null };
  }
  fetchTransfers(address: string, opts: { before?: string | null; budget: Budget }) {
    return combinedFetch(this, address, opts.before, opts.budget);
  }
  balances: RawBalance[] = [];
  async fetchBalances(): Promise<RawBalance[]> {
    if (this.fail) throw this.fail;
    return this.balances;
  }
  async ping() {
    return { ok: !this.fail };
  }
}

export const ETH_A = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
export const ETH_B = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
export const ETH_C = "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB";
export const SOL_A = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

let txn = 0;
export function ethTransfer(from: string, to: string, blockTime: number, opts: Partial<RawTransfer> = {}): RawTransfer {
  txn++;
  const hash = "0x" + txn.toString(16).padStart(64, "0");
  return {
    chain: "ethereum",
    id: `${hash}_t0`,
    txHash: hash,
    blockNumber: 1000 + txn,
    blockTime,
    from,
    to,
    fromOwner: null,
    toOwner: null,
    tokenId: "native",
    tokenSymbol: "ETH",
    tokenName: "Ether",
    tokenDecimals: 18,
    tokenStandard: "native",
    amountRaw: "1000000000000000000",
    priceCoin: "coingecko:ethereum",
    ...opts,
  };
}

/** fetch stub for DefiLlama: every coin costs `price` USD (or is unknown when listed in `unknown`). */
export function llamaFetch(price = 2000, unknown: string[] = []): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/batchHistorical")) {
      const q = JSON.parse(decodeURIComponent(new URL(url).searchParams.get("coins")!)) as Record<string, number[]>;
      const coins: Record<string, unknown> = {};
      for (const [c, tss] of Object.entries(q)) if (!unknown.includes(c)) coins[c] = { symbol: "TKN", prices: tss.map((t) => ({ timestamp: t, price, confidence: 0.99 })) };
      return new Response(JSON.stringify({ coins }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/prices/current/")) {
      const list = decodeURIComponent(url.split("/prices/current/")[1]!).split(",");
      const coins: Record<string, unknown> = {};
      for (const c of list) if (!unknown.includes(c)) coins[c] = { price, symbol: "TKN", timestamp: 1, confidence: 0.99 };
      return new Response(JSON.stringify({ coins }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

export type TestApp = {
  app: FastifyInstance;
  ctx: Awaited<ReturnType<typeof buildApp>>["ctx"];
  worker: Awaited<ReturnType<typeof buildApp>>["worker"];
  eth: FakeProvider;
  sol: FakeProvider;
  bnb: FakeProvider;
  sent: { url: string; body: string; headers: Record<string, string> }[];
  close: () => Promise<void>;
};

export async function makeApp(over: Partial<Config> = {}, opts: { sendWebhook?: WebhookSender; ethStreams?: string[] } = {}): Promise<TestApp> {
  const config = { ...loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), dbPath: ":memory:", ...over };
  const db = openDb(":memory:");
  const eth = new FakeProvider("ethereum", opts.ethStreams);
  const sol = new FakeProvider("solana");
  const bnb = new FakeProvider("bnb");
  const sent: TestApp["sent"] = [];
  const { app, ctx, worker } = await buildApp(config, {
    db,
    providers: { ethereum: eth, solana: sol, bnb },
    prices: new PriceService(db, "https://prices.test", llamaFetch()),
    resolver: async (host) => (host === "hooks.example.com" ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "10.0.0.5", family: 4 }]),
    sendWebhook:
      opts.sendWebhook ??
      (async (url, body, headers) => {
        sent.push({ url, body, headers });
        return { ok: true, status: 200, detail: "HTTP 200" };
      }),
    logger: false,
  });
  await app.ready();
  return {
    app,
    ctx,
    worker,
    eth,
    sol,
    bnb,
    sent,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

/** A signed-in client: keeps the session cookie and sends Origin + JSON headers. */
export class Client {
  cookie = "";
  constructor(readonly app: FastifyInstance) {}
  async req(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    const res = await this.app.inject({
      method,
      url,
      headers: {
        origin: ORIGIN,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    const set = res.cookies.find((c) => c.name === "osstrace_session");
    if (set) this.cookie = set.value ? `osstrace_session=${set.value}` : "";
    return res;
  }
  get = (url: string) => this.req("GET", url);
  post = (url: string, body?: unknown) => this.req("POST", url, body ?? {});
  patch = (url: string, body: unknown) => this.req("PATCH", url, body);
  del = (url: string, body?: unknown) => this.req("DELETE", url, body);
}

/** Deterministic Solana keypair from `seed`, for tests that need a stable address across calls. */
export function testWallet(seed: string): { address: string; secretKey: Uint8Array } {
  const kp = nacl.sign.keyPair.fromSeed(createHash("sha256").update(seed).digest());
  return { address: bs58.encode(Buffer.from(kp.publicKey)), secretKey: kp.secretKey };
}

/** Runs the real challenge -> sign -> verify flow for a fresh, deterministic solana wallet and returns a signed-in client. */
export async function signup(app: FastifyInstance, seed: string): Promise<Client> {
  const c = new Client(app);
  const { address, secretKey } = testWallet(seed);
  const chal = await c.post("/api/auth/challenge", { chain: "solana", address });
  if (chal.statusCode !== 200) throw new Error(`challenge failed: ${chal.statusCode} ${chal.body}`);
  const { message, nonce } = chal.json() as { message: string; nonce: string };
  const signature = Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), secretKey)).toString("base64");
  const r = await c.post("/api/auth/verify", { chain: "solana", address, nonce, signature });
  if (r.statusCode !== 200) throw new Error(`verify failed: ${r.statusCode} ${r.body}`);
  return c;
}
