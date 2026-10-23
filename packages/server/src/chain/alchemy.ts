import { createHash } from "node:crypto";
import { CHAIN_NAMES, toChecksumAddress, type Chain } from "@osstrace/contract";
import { ProviderError } from "../lib/errors.ts";
import { HttpClient, type Budget } from "../lib/http.ts";
import { isPositiveIntString } from "./amount.ts";
import { NATIVE_COIN, tokenCoin } from "./prices.ts";
import { httpsUrl } from "./tokenLogos.ts";
import { combinedFetch, type ChainProvider, type RawBalance, type RawTransfer, type StreamPage } from "./types.ts";

// EVM address history and balances through Alchemy's enhanced JSON-RPC methods
// (`alchemy_getAssetTransfers`, `alchemy_getTokenBalances`, `alchemy_getTokenMetadata`), sent to the
// same per-chain RPC URL the chain already uses for plain `eth_*` calls. It's how chains whose public
// indexers can't be read server-side get their history: Etherscan's free tier refuses BNB Smart Chain
// (chain 56), and Robinhood Chain's and Base's own Blockscout instances answer every non-browser call
// with a Cloudflare challenge.
//
// Response shapes (only the fields read here) match real Alchemy answers, checked against BNB, Base
// and Robinhood Chain mainnet on 2026-10-23. Every amount is read from `rawContract.value` (hex,
// base units) -- never `value`, which Alchemy pre-scales into a lossy float.

type AlTransfer = {
  blockNum: string;
  uniqueId: string;
  hash: string;
  from: string | null;
  to: string | null;
  /** Lossy decimal float -- ignored. */
  value?: number | null;
  erc721TokenId?: string | null;
  erc1155Metadata?: { tokenId: string; value: string }[] | null;
  tokenId?: string | null;
  /** The token's symbol (or the native symbol); null for most NFTs. */
  asset: string | null;
  category: string;
  rawContract: { value: string | null; address: string | null; decimal: string | null };
  metadata?: { blockTimestamp?: string | null } | null;
};
type AlTransfersResult = { transfers: AlTransfer[]; pageKey?: string | null };
type AlTokenBalances = { address: string; tokenBalances: { contractAddress: string; tokenBalance: string | null; error?: unknown }[]; pageKey?: string | null };
type AlTokenMetadata = { decimals: number | null; logo: string | null; name: string | null; symbol: string | null };
type RpcReply<T> = { jsonrpc?: string; id?: number; result?: T; error?: { code?: number; message?: string } | null };

/** Rows per `alchemy_getAssetTransfers` page -- Alchemy's own default and maximum (0x3e8). */
const PAGE_SIZE = 1000;
/** ERC-20's `decimals()` is a uint8; anything outside it is unknown, not something to scale by. */
const MAX_DECIMALS = 255;
/** `alchemy_getTokenBalances` pages (100 contracts each, zero balances included) read per balances call. */
const TOKEN_BALANCE_PAGES = 10;
/** `alchemy_getTokenMetadata` requests per JSON-RPC batch. */
const METADATA_BATCH = 100;
/** ERC-20 `decimals()` selector, read on-chain when Alchemy has no decimals for a token. */
const DECIMALS_SELECTOR = "0x313ce567";
/** Most contracts whose `decimals()` is read per page (one JSON-RPC batch). */
const DECIMALS_BATCH = 100;

const cs = (h: string | undefined | null) => (h && /^0x[0-9a-fA-F]{40}$/.test(h) ? toChecksumAddress(h) : null);
const hexInt = (h: string | null | undefined): bigint | null => (typeof h === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(h) ? BigInt(h) : null);
const decimalsOf = (d: unknown): number | null => {
  const n = typeof d === "string" ? hexInt(d) : typeof d === "number" && Number.isInteger(d) ? BigInt(d) : null;
  return n !== null && n >= 0n && n <= BigInt(MAX_DECIMALS) ? Number(n) : null;
};
const sec = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};

export type AlchemyNative = { chain: Chain; nativeSymbol: string; nativeName: string };

/**
 * The id a transfer is stored under, from Alchemy's `uniqueId` (`<tx>:external`, `<tx>:log:<logIndex>`,
 * `<tx>:internal:<tracePath>`). Same id scheme the other EVM providers use, so a transfer reads back
 * as one row whichever direction's query found it: `<tx>_t0` for a top-level value transfer,
 * `<tx>_<logIndex>` for a token transfer log, `<tx>_i<tracePath>` for an internal call. Anything
 * Alchemy ever sends in another shape still gets a stable id (a hash of its own uniqueId).
 */
function idOf(t: AlTransfer): string {
  const m = /^0x[0-9a-fA-F]{64}:(external|log:(\d+)|internal:([0-9_]+))$/.exec(t.uniqueId ?? "");
  if (m?.[1] === "external") return `${t.hash}_t0`;
  if (m?.[2] !== undefined) return `${t.hash}_${m[2]}`;
  if (m?.[3] !== undefined) return `${t.hash}_i${m[3]}`;
  return `${t.hash}_u${createHash("sha256").update(String(t.uniqueId)).digest("hex").slice(0, 16)}`;
}

/**
 * Alchemy transfer rows as RawTransfers. Covers `external` and `internal` (native value), `erc20`,
 * `erc721` and `erc1155` -- the same set Blockscout's three streams give Ethereum. Alchemy already
 * leaves out reverted transactions (checked against real failed value transfers on BNB and Base:
 * neither came back) and zero-value rows (`excludeZeroValue`), so nothing here has to filter them.
 */
export function normalizeAlchemyTransfers(items: AlTransfer[], n: AlchemyNative): RawTransfer[] {
  const out: RawTransfer[] = [];
  for (const t of items) {
    const time = sec(t.metadata?.blockTimestamp);
    const block = hexInt(t.blockNum);
    const from = cs(t.from);
    const to = cs(t.to);
    if (time === null || block === null || !from || !to || !/^0x[0-9a-fA-F]{64}$/.test(t.hash ?? "")) continue;
    const head = { chain: n.chain, txHash: t.hash, blockNumber: Number(block), blockTime: time, from, to, fromOwner: null, toOwner: null };
    const id = idOf(t);
    if (t.category === "external" || t.category === "internal") {
      const amountRaw = hexInt(t.rawContract?.value)?.toString();
      if (!isPositiveIntString(amountRaw)) continue;
      out.push({ ...head, id, tokenId: "native", tokenSymbol: n.nativeSymbol, tokenName: n.nativeName, tokenDecimals: 18, tokenStandard: "native", amountRaw, priceCoin: NATIVE_COIN[n.chain] });
      continue;
    }
    const contract = cs(t.rawContract?.address);
    if (!contract) continue;
    if (t.category === "erc20") {
      const amountRaw = hexInt(t.rawContract.value)?.toString();
      if (!isPositiveIntString(amountRaw)) continue;
      out.push({ ...head, id, tokenId: contract, tokenSymbol: t.asset || null, tokenName: null, tokenDecimals: decimalsOf(t.rawContract.decimal), tokenStandard: "erc20", amountRaw, priceCoin: tokenCoin(n.chain, contract) });
    } else if (t.category === "erc721") {
      const tokenId = hexInt(t.erc721TokenId ?? t.tokenId);
      out.push({ ...head, id, tokenId: contract, tokenSymbol: t.asset || null, tokenName: tokenId !== null ? `#${tokenId}` : null, tokenDecimals: 0, tokenStandard: "erc721", amountRaw: "1", priceCoin: null });
    } else if (t.category === "erc1155") {
      // One log can move several token ids (TransferBatch): one row each, `_1`, `_2`... after the
      // first, in Alchemy's own fixed order -- the same suffixing Blockscout's normalizer uses.
      let k = 0;
      for (const m of t.erc1155Metadata ?? []) {
        const amountRaw = hexInt(m?.value)?.toString();
        if (!isPositiveIntString(amountRaw)) continue;
        const tokenId = hexInt(m.tokenId);
        out.push({ ...head, id: k === 0 ? id : `${id}_${k}`, tokenId: contract, tokenSymbol: t.asset || null, tokenName: tokenId !== null ? `#${tokenId}` : null, tokenDecimals: 0, tokenStandard: "erc1155", amountRaw, priceCoin: null });
        k++;
      }
    }
    // Any other category (e.g. Ethereum-only `specialnft`) isn't requested and isn't supported here.
  }
  return out;
}

/**
 * Per-stream paging cursor: `k` = Alchemy's `pageKey` for the next page, `b` = the oldest block the
 * page that produced it reached. The pageKey is the exact continuation; `b` is the fallback if Alchemy
 * ever stops accepting a stored pageKey (its docs promise no lifetime, and sync keeps cursors in the
 * database between requests): the stream then restarts at the top of block `b` -- re-reading that
 * block is harmless (ids are stable, the store ignores rows it already has) and skips nothing.
 */
type Cursor = { k: string; b: number };

export type AlchemyOptions = AlchemyNative & {
  /** EVM chain id the RPC must answer `eth_chainId` with -- checked once before any data is read,
   *  so a URL for the wrong network can never fill this chain with another chain's rows. */
  chainId: number;
  rpcUrl: string;
  /** Name of the env var the URL comes from, for error messages (never the URL itself). */
  rpcEnv: string;
  /** Whether Alchemy serves the `internal` category on this network (only a few networks: Base yes,
   *  BNB and Robinhood Chain no -- Alchemy answers -32602 "not supported for this network"). */
  internal?: boolean;
};

/** One instance per EVM chain read through Alchemy (BNB Chain, Robinhood Chain, Base). */
export class AlchemyProvider implements ChainProvider {
  readonly chain: Chain;
  readonly id: string;
  readonly name: string;
  readonly http: HttpClient;
  private readonly chainId: number;
  private readonly rpcUrl: string;
  private readonly rpcEnv: string;
  private readonly native: AlchemyNative;
  private readonly categories: string[];
  private readonly secrets: string[] = [];
  private verified: Promise<void> | null = null;
  /** Set once an enhanced call has succeeded, so `ping` stops spending compute units re-proving it. */
  private enhancedOk = false;
  /** ERC-20 decimals read on-chain via `decimals()` (only successful reads are kept). */
  private readonly decimalsCache = new Map<string, number>();

  constructor(opts: AlchemyOptions & { fetchImpl?: typeof fetch | undefined }) {
    this.chain = opts.chain;
    this.chainId = opts.chainId;
    this.rpcUrl = opts.rpcUrl;
    this.rpcEnv = opts.rpcEnv;
    this.native = { chain: opts.chain, nativeSymbol: opts.nativeSymbol, nativeName: opts.nativeName };
    this.id = `alchemy-${opts.chain}`;
    // The chain's name, not the URL's host: some RPC hosts carry the key in the hostname itself.
    this.name = `Alchemy (${CHAIN_NAMES[opts.chain]})`;
    this.categories = ["external", ...(opts.internal ? ["internal"] : []), "erc20", "erc721", "erc1155"];
    this.http = new HttpClient(this.id, 4, opts.fetchImpl);
    // Alchemy keys live in the URL path. Anything that looks like one is scrubbed from upstream error
    // text before it can reach a message, even though Alchemy has never been seen to echo it.
    try {
      const u = new URL(opts.rpcUrl);
      this.secrets = [...u.pathname.split("/"), ...u.hostname.split("."), u.search.slice(1)].filter((s) => s.length >= 12);
    } catch {
      /* an unparseable URL fails on the first request with HttpClient's own (URL-free) error */
    }
  }

  streams() {
    // Alchemy filters by one direction per query, so incoming and outgoing are independent
    // newest-first histories. A self-transfer appears in both under the same id and is stored once.
    return ["incoming", "outgoing"];
  }

  private scrub(s: string) {
    let out = s;
    for (const x of this.secrets) out = out.split(x).join("[redacted]");
    return out.slice(0, 200);
  }

  /** What a refusal of an Alchemy-only method means: the configured RPC isn't an Alchemy endpoint
   *  (or its key is no good -- Alchemy itself answers 401 to a bad key). */
  private notAlchemy(why: string) {
    return new ProviderError(this.id, `${CHAIN_NAMES[this.chain]} address lookups need an Alchemy RPC URL with a valid key in ${this.rpcEnv} -- the configured RPC refused Alchemy's enhanced API (${why})`, 3600);
  }

  private replyError(method: string, err: { code?: number; message?: string }): ProviderError {
    const msg = this.scrub(String(err.message ?? "unknown error"));
    if (err.code === -32601 || /does not exist|is not available|method not found/i.test(msg)) return this.notAlchemy(`${method} is not available`);
    if (err.code === 429 || /exceeded its compute units|rate limit|too many requests/i.test(msg)) {
      this.http.coolDown("*", 1);
      return new ProviderError(this.id, `${this.id} is rate limited`, 1);
    }
    return new ProviderError(this.id, `Alchemy ${method}: ${msg}`);
  }

  private async post<T>(body: unknown, budget: Budget | undefined, opts: { timeoutMs?: number; maxRetries?: number } = {}): Promise<T> {
    try {
      const { data } = await this.http.json<T>(this.rpcUrl, { method: "POST", body, budget, timeoutMs: opts.timeoutMs ?? 20_000, maxRetries: opts.maxRetries ?? 3 });
      return data;
    } catch (e) {
      // A public non-Alchemy RPC may refuse an alchemy_* method at the HTTP level instead (Base's own
      // endpoint answers 401 "rejected due to request filter settings").
      const m = e instanceof ProviderError ? /HTTP (401|403|405)$/.exec(e.message) : null;
      if (m) throw this.notAlchemy(`HTTP ${m[1]}`);
      throw e;
    }
  }

  private async rpc<T>(method: string, params: unknown[], budget: Budget | undefined, opts: { timeoutMs?: number; maxRetries?: number } = {}): Promise<T> {
    const reply = await this.post<RpcReply<T>>({ jsonrpc: "2.0", id: 1, method, params }, budget, opts);
    if (!reply || typeof reply !== "object") throw new ProviderError(this.id, `Alchemy ${method} returned an unexpected response`);
    if (reply.error) throw this.replyError(method, reply.error);
    if (reply.result === undefined || reply.result === null) throw new ProviderError(this.id, `Alchemy ${method} returned no result`);
    return reply.result;
  }

  private async checkChainId(budget: Budget | undefined, opts: { timeoutMs?: number; maxRetries?: number } = {}) {
    const got = hexInt(await this.rpc<string>("eth_chainId", [], budget, { timeoutMs: 8000, ...opts }));
    if (got !== BigInt(this.chainId)) {
      throw new ProviderError(this.id, `${this.rpcEnv} answers for chain id ${got ?? "unknown"}, not ${CHAIN_NAMES[this.chain]}'s ${this.chainId} -- check the URL`, 3600);
    }
  }

  /** The RPC is on the chain this provider stores rows for. Checked once; a failure is retried next call. */
  private ensureChain(budget: Budget | undefined): Promise<void> {
    this.verified ??= this.checkChainId(budget);
    const p = this.verified;
    p.catch(() => {
      if (this.verified === p) this.verified = null;
    });
    return p;
  }

  private parseCursor(cursor: string | null): Cursor | null {
    if (!cursor) return null;
    try {
      const c = JSON.parse(cursor) as Cursor;
      if (typeof c.k === "string" && c.k.length > 0 && c.k.length <= 200 && Number.isSafeInteger(c.b) && c.b >= 0) return c;
    } catch {
      /* fall through */
    }
    throw new ProviderError(this.id, `invalid ${CHAIN_NAMES[this.chain]} paging cursor`);
  }

  async fetchStreamPage(address: string, stream: string, cursor: string | null, budget: Budget): Promise<StreamPage> {
    if (stream !== "incoming" && stream !== "outgoing") throw new ProviderError(this.id, `unknown stream ${stream}`);
    const a = toChecksumAddress(address);
    const cur = this.parseCursor(cursor);
    await this.ensureChain(budget);
    const query = {
      [stream === "incoming" ? "toAddress" : "fromAddress"]: a,
      fromBlock: "0x0",
      category: this.categories,
      order: "desc",
      withMetadata: true,
      excludeZeroValue: true,
      maxCount: `0x${PAGE_SIZE.toString(16)}`,
    };
    let result: AlTransfersResult;
    if (!cur) result = await this.rpc<AlTransfersResult>("alchemy_getAssetTransfers", [query], budget);
    else {
      try {
        result = await this.rpc<AlTransfersResult>("alchemy_getAssetTransfers", [{ ...query, pageKey: cur.k }], budget);
      } catch (e) {
        // Alchemy rejects a pageKey it no longer accepts with HTTP 400 (or a -32602 naming it).
        if (!(e instanceof ProviderError && /HTTP 400$|page ?key/i.test(e.message))) throw e;
        result = await this.rpc<AlTransfersResult>("alchemy_getAssetTransfers", [{ ...query, toBlock: `0x${cur.b.toString(16)}` }], budget);
      }
    }
    if (!result || !Array.isArray(result.transfers)) throw new ProviderError(this.id, "Alchemy alchemy_getAssetTransfers returned an unexpected response");
    this.enhancedOk = true;
    const items = result.transfers;
    const times = items.map((t) => sec(t?.metadata?.blockTimestamp)).filter((x): x is number => x !== null);
    const blocks = items.map((t) => hexInt(t?.blockNum)).filter((x): x is bigint => x !== null);
    const oldestBlock = blocks.length ? Number(blocks.reduce((m, b) => (b < m ? b : m))) : cur?.b ?? 0;
    const pageKey = typeof result.pageKey === "string" && result.pageKey ? result.pageKey : null;
    const next: Cursor | null = pageKey ? { k: pageKey, b: oldestBlock } : null;
    const transfers = normalizeAlchemyTransfers(items, this.native);
    await this.fillMissingDecimals(transfers, budget);
    return {
      transfers,
      nextCursor: next ? JSON.stringify(next) : null,
      oldestTime: times.length ? Math.min(...times) : null,
      newestTime: times.length ? Math.max(...times) : null,
    };
  }

  /**
   * Alchemy has no decimals for some real, priced ERC-20s (`rawContract.decimal: null`, and
   * `alchemy_getTokenMetadata` answers `decimals: null` too -- seen on BNB Chain's MYX token, whose
   * contract's own `decimals()` says 18). Stored like that, the amount would be the unscaled base-unit
   * integer, and a USD price times it is off by 10^decimals (a ~$80 swap read as $1.27e19). This reads
   * `decimals()` from the token contract itself, in one batched `eth_call`, for each such token on the
   * page. Best effort: a token whose call reverts or fails keeps `tokenDecimals: null` (sync then
   * leaves it unpriced rather than price an unscaled amount); a failed batch never fails the page.
   */
  private async fillMissingDecimals(transfers: RawTransfer[], budget: Budget) {
    const missing = transfers.filter((t) => t.tokenStandard === "erc20" && t.tokenDecimals === null);
    if (missing.length === 0) return;
    const unknown = [...new Set(missing.map((t) => t.tokenId))].filter((c) => !this.decimalsCache.has(c)).slice(0, DECIMALS_BATCH);
    if (unknown.length > 0) {
      try {
        const res = await this.post<RpcReply<string>[]>(
          unknown.map((c, j) => ({ jsonrpc: "2.0", id: j, method: "eth_call", params: [{ to: c, data: DECIMALS_SELECTOR }, "latest"] })),
          budget,
          { timeoutMs: 10_000, maxRetries: 1 },
        );
        // Pair by id, never by position (LESSONS.md).
        for (const r of Array.isArray(res) ? res : []) {
          const c = typeof r?.id === "number" ? unknown[r.id] : undefined;
          const d = c && !r.error ? decimalsOf(r.result) : null;
          if (c && d !== null) this.decimalsCache.set(c, d);
        }
      } catch {
        /* decimals stay unknown for this page; the rows are still real transfers */
      }
    }
    for (const t of missing) t.tokenDecimals = this.decimalsCache.get(t.tokenId) ?? null;
  }

  /** Both directions' pages combined. A transfer the address sent to itself matches both queries;
   *  it's returned once. */
  async fetchTransfers(address: string, opts: { before?: string | null; budget: Budget }) {
    const r = await combinedFetch(this, address, opts.before, opts.budget);
    const seen = new Set<string>();
    return { transfers: r.transfers.filter((t) => !seen.has(t.id) && (seen.add(t.id), true)), nextCursor: r.nextCursor };
  }

  /**
   * Native balance from `eth_getBalance`; ERC-20 holdings from `alchemy_getTokenBalances` (every
   * contract the address has ever held, current balances), named via `alchemy_getTokenMetadata`.
   * Any request-level failure throws: a native-only or token-less list would look like a complete
   * wallet. A single token whose balance or metadata Alchemy can't read is left out / left unnamed.
   *
   * Coverage limit: at most 1000 token contracts (10 pages) are read per call -- a wallet sprayed with
   * more airdropped tokens than that can be missing some.
   */
  async fetchBalances(address: string, budget: Budget): Promise<RawBalance[]> {
    const a = toChecksumAddress(address);
    await this.ensureChain(budget);
    const tokenPages = async () => {
      const rows: AlTokenBalances["tokenBalances"] = [];
      let pageKey: string | null = null;
      for (let i = 0; i < TOKEN_BALANCE_PAGES; i++) {
        const res: AlTokenBalances = await this.rpc<AlTokenBalances>("alchemy_getTokenBalances", [a, "erc20", ...(pageKey ? [{ pageKey }] : [])], budget);
        if (!res || !Array.isArray(res.tokenBalances)) throw new ProviderError(this.id, "Alchemy alchemy_getTokenBalances returned an unexpected response");
        rows.push(...res.tokenBalances);
        pageKey = typeof res.pageKey === "string" && res.pageKey ? res.pageKey : null;
        if (!pageKey || Date.now() > budget.deadline - 3000) break;
      }
      return rows;
    };
    const [wei, tokenRows] = await Promise.all([this.rpc<string>("eth_getBalance", [a, "latest"], budget), tokenPages()]);
    this.enhancedOk = true;
    const nativeWei = hexInt(wei === "0x" ? "0x0" : wei);
    if (nativeWei === null) throw new ProviderError(this.id, "Alchemy eth_getBalance returned an unexpected response");

    const held = new Map<string, bigint>();
    for (const r of tokenRows) {
      const c = cs(r?.contractAddress);
      const amt = r?.error ? null : hexInt(r?.tokenBalance);
      if (c && amt !== null && amt > 0n && !held.has(c)) held.set(c, amt);
    }
    const contracts = [...held.keys()];
    const meta = new Map<string, AlTokenMetadata>();
    const batches: string[][] = [];
    for (let i = 0; i < contracts.length; i += METADATA_BATCH) batches.push(contracts.slice(i, i + METADATA_BATCH));
    await Promise.all(
      batches.map(async (part) => {
        const res = await this.post<RpcReply<AlTokenMetadata>[]>(
          part.map((c, j) => ({ jsonrpc: "2.0", id: j, method: "alchemy_getTokenMetadata", params: [c] })),
          budget,
        );
        if (!Array.isArray(res)) throw new ProviderError(this.id, "Alchemy alchemy_getTokenMetadata returned an unexpected batch response");
        // Batched JSON-RPC results can come back in any order: pair by id, never by position (LESSONS.md).
        for (const r of res) {
          const c = typeof r?.id === "number" ? part[r.id] : undefined;
          if (c && r.result && typeof r.result === "object") meta.set(c, r.result);
        }
      }),
    );

    const out: RawBalance[] = [];
    if (nativeWei > 0n) out.push({ tokenId: "native", symbol: this.native.nativeSymbol, name: this.native.nativeName, decimals: 18, amountRaw: nativeWei.toString(), priceCoin: NATIVE_COIN[this.chain] });
    for (const c of contracts) {
      const m = meta.get(c);
      out.push({
        tokenId: c,
        symbol: typeof m?.symbol === "string" && m.symbol ? m.symbol.slice(0, 64) : null,
        name: typeof m?.name === "string" && m.name ? m.name.slice(0, 128) : null,
        decimals: decimalsOf(m?.decimals),
        amountRaw: held.get(c)!.toString(),
        priceCoin: tokenCoin(this.chain, c),
        logoUrl: httpsUrl(m?.logo),
      });
    }
    return out;
  }

  async ping() {
    try {
      // A fresh eth_chainId every time (no compute-unit cost worth counting): proves the RPC is up and
      // on the right chain.
      await this.checkChainId(undefined, { maxRetries: 0 });
      // One real enhanced call per process, until some lookup has already proved the method works:
      // the health route pings every minute, and alchemy_getAssetTransfers costs compute units.
      if (!this.enhancedOk) {
        await this.rpc("alchemy_getAssetTransfers", [{ toAddress: "0x0000000000000000000000000000000000000000", category: ["external"], order: "desc", maxCount: "0x1" }], undefined, { timeoutMs: 8000, maxRetries: 0 });
        this.enhancedOk = true;
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, note: e instanceof Error ? e.message : "unreachable" };
    }
  }
}
