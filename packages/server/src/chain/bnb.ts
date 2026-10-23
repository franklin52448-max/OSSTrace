import { createHash } from "node:crypto";
import { toChecksumAddress } from "@osstrace/contract";
import { ProviderError } from "../lib/errors.ts";
import { HttpClient, type Budget } from "../lib/http.ts";
import { isPositiveIntString } from "./amount.ts";
import { NATIVE_COIN, tokenCoin } from "./prices.ts";
import { combinedFetch, type ChainProvider, type RawBalance, type RawTransfer, type StreamPage } from "./types.ts";

// BNB Smart Chain via Etherscan's V2 API. Ethereum reads Blockscout (chain/ethereum.ts), but there is
// no free hosted Blockscout for BNB mainnet; Etherscan V2 is multichain (one key, `chainid=56`), so
// the same key that serves Ethereum elsewhere in this repo covers BNB -- *if* its plan includes BNB.
// Etherscan's free tier refuses chain 56 outright; that answer is surfaced as-is (see `call`), never
// turned into an empty history.
//
// Response shapes (only the fields read here) match real Etherscan V2 `account` rows; every value
// arrives as a string, addresses lowercase.

export const BNB_CHAIN_ID = 56;

type EsTx = { blockNumber: string; timeStamp: string; hash: string; from: string; to: string; value: string; contractAddress: string; isError: string; txreceipt_status?: string };
type EsInternal = { blockNumber: string; timeStamp: string; hash: string; from: string; to: string; value: string; contractAddress: string; isError: string; traceId?: string };
type EsTokenTx = {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  contractAddress: string;
  value?: string;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimal?: string;
  /** tokennfttx / token1155tx */
  tokenID?: string;
  /** token1155tx only: the amount of `tokenID` moved. */
  tokenValue?: string;
};
type EsResponse<T> = { status: string; message: string; result: T[] | string | null };

const BNB_DECIMALS = 18;
/** Etherscan's own ceiling for one account query: `page × offset` ≤ 10000. */
const MAX_WINDOW = 10_000;
const PAGE_SIZE = 1000;
/** ERC-20's `decimals()` is a uint8. A token can report anything (anyone can deploy one and airdrop
 *  it to any address), and scaling by 10^(huge) blocks the event loop -- out of range means unknown. */
const MAX_DECIMALS = 255;
/** Distinct BEP-20 contracts whose live `balanceOf` is read per balances call. */
const MAX_BALANCE_TOKENS = 200;

const cs = (h: string | undefined | null) => (h && /^0x[0-9a-fA-F]{40}$/.test(h) ? toChecksumAddress(h) : null);
const decimalsOf = (d: string | undefined) => (d !== undefined && /^\d+$/.test(d) && Number(d) <= MAX_DECIMALS ? Number(d) : null);

function base(r: { hash: string; blockNumber: string; timeStamp: string }) {
  return { chain: "bnb" as const, txHash: r.hash, blockNumber: Number(r.blockNumber), blockTime: Number(r.timeStamp), fromOwner: null, toOwner: null };
}

const native = { tokenId: "native", tokenSymbol: "BNB", tokenName: "BNB", tokenDecimals: BNB_DECIMALS, tokenStandard: "native" as const, priceCoin: NATIVE_COIN.bnb };

/** Native BNB moved by a top-level transaction (successful, value > 0). Id `<tx>_t0`, as on Ethereum. */
export function normalizeBnbTransactions(rows: EsTx[]): RawTransfer[] {
  const out: RawTransfer[] = [];
  for (const t of rows) {
    // `isError` is the execution result; `txreceipt_status` "0" is a failed receipt (post-Byzantium).
    // Either one means nothing moved -- a reverted value transfer must never resolve as a transfer.
    if (t.isError !== "0" || t.txreceipt_status === "0" || !isPositiveIntString(t.value)) continue;
    const from = cs(t.from);
    const to = cs(t.to || t.contractAddress);
    if (!from || !to) continue;
    out.push({ ...base(t), id: `${t.hash}_t0`, from, to, ...native, amountRaw: t.value });
  }
  return out;
}

/** Native BNB moved by internal calls (successful, value > 0). Id `<tx>_i<traceId>`: Etherscan's
 *  traceId is the call's own path in the trace tree ("0_1_1"), so it's stable across refetches. */
export function normalizeBnbInternal(rows: EsInternal[]): RawTransfer[] {
  const out: RawTransfer[] = [];
  for (const t of rows) {
    if (t.isError !== "0" || !isPositiveIntString(t.value) || !t.traceId) continue;
    const from = cs(t.from);
    const to = cs(t.to || t.contractAddress);
    if (!from || !to) continue;
    out.push({ ...base(t), id: `${t.hash}_i${t.traceId}`, from, to, ...native, amountRaw: t.value });
  }
  return out;
}

/**
 * BEP-20 (`tokentx`), BEP-721 (`tokennfttx`) and BEP-1155 (`token1155tx`) transfers, tagged with the
 * same erc* standards Ethereum uses -- the token standards are byte-for-byte the same on BSC.
 *
 * Ids: unlike Blockscout, Etherscan's token rows carry no log index, so the id is the tx hash plus a
 * hash of the transfer's own fields (the same fix Solscan needed, chain/solscan.ts): deriving it from
 * a row's position in whatever page it arrived in would give one real transfer two ids once paging
 * re-fetches a block, and it would show twice. Rows identical in every field within one tx (e.g. the
 * same amount sent to the same address twice) are told apart by occurrence order, `_1`, `_2`...;
 * Etherscan returns a tx's rows together and in a fixed order, so that order is stable too. Hashed,
 * not concatenated, so the id stays well under the 200-char transfer-id cap.
 */
export function normalizeBnbTokenTransfers(rows: EsTokenTx[], standard: "erc20" | "erc721" | "erc1155"): RawTransfer[] {
  const out: RawTransfer[] = [];
  const seen = new Map<string, number>();
  for (const t of rows) {
    const from = cs(t.from);
    const to = cs(t.to);
    const contract = cs(t.contractAddress);
    if (!from || !to || !contract) continue;
    let amountRaw: string | undefined;
    let decimals: number | null;
    if (standard === "erc20") {
      amountRaw = t.value;
      decimals = decimalsOf(t.tokenDecimal);
    } else if (standard === "erc721") {
      amountRaw = "1";
      decimals = 0;
    } else {
      amountRaw = t.tokenValue;
      decimals = 0;
    }
    if (!isPositiveIntString(amountRaw)) continue;
    const suffix = createHash("sha256").update(`${standard}_${contract}_${from}_${to}_${amountRaw}_${t.tokenID ?? ""}`).digest("hex").slice(0, 16);
    const key = `${t.hash}_${suffix}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    out.push({
      ...base(t),
      id: n === 0 ? key : `${key}_${n}`,
      from,
      to,
      tokenId: contract,
      tokenSymbol: t.tokenSymbol || null,
      tokenName: standard === "erc20" ? t.tokenName || null : [t.tokenName, t.tokenID ? `#${t.tokenID}` : null].filter(Boolean).join(" ") || null,
      tokenDecimals: decimals,
      tokenStandard: standard,
      amountRaw,
      priceCoin: standard === "erc20" ? tokenCoin("bnb", contract) : null,
    });
  }
  return out;
}

/**
 * Per-stream paging cursor over Etherscan's block range: `e` = the `endblock` to ask for (inclusive),
 * `p` = the page within it. Not plain `page=N` from the head: page × offset is capped at 10000, and
 * a busy address has far more history than that. Moving `endblock` down to the oldest block of each
 * full page re-fetches that block from its top -- the overlap is harmless (ids are stable, the store
 * ignores rows it already has), and it means a page that cut a block in half never skips the rest.
 */
type Cursor = { e: number | null; p: number };

/** The cursor after a full page whose rows span blocks `lowest`..`highest`, or `{ skip }` when a
 *  single block holds more rows than Etherscan can page through at all. Exported for tests. */
export function nextBnbCursor(cur: Cursor, lowest: number, highest: number): Cursor | { skip: number } {
  // The page spans more than one block, so it began above `lowest`: restarting at the top of
  // `lowest` always ends further down than this page did.
  if (lowest < highest) return { e: lowest, p: 1 };
  // The whole page sits inside one block. Already paging inside it: next page. Arrived at it from
  // above on page 1: block `lowest` starts this page, so page 2 of it is exactly the rest. From
  // a deeper page we don't know where the block began, so start it over (and then page within it).
  const p = cur.e === lowest ? cur.p + 1 : cur.p === 1 ? 2 : 1;
  if (p * PAGE_SIZE > MAX_WINDOW) return { skip: lowest };
  return { e: lowest, p };
}

const ACTIONS: Record<string, { action: string; normalize: (rows: never[]) => RawTransfer[] }> = {
  transactions: { action: "txlist", normalize: (r: EsTx[]) => normalizeBnbTransactions(r) },
  "internal-transactions": { action: "txlistinternal", normalize: (r: EsInternal[]) => normalizeBnbInternal(r) },
  "token-transfers": { action: "tokentx", normalize: (r: EsTokenTx[]) => normalizeBnbTokenTransfers(r, "erc20") },
  "nft-transfers": { action: "tokennfttx", normalize: (r: EsTokenTx[]) => normalizeBnbTokenTransfers(r, "erc721") },
  "multi-token-transfers": { action: "token1155tx", normalize: (r: EsTokenTx[]) => normalizeBnbTokenTransfers(r, "erc1155") },
};

/** `request`'s answer for Etherscan's "No transactions found" -- a real, empty history. */
const EMPTY = Symbol("empty");

// keccak256("balanceOf(address)")[0..4] -- the standard ERC-20 selector, not this project's invention.
const BALANCE_OF = "0x70a08231";
const RPC_BATCH = 50;

export class EtherscanBnbProvider implements ChainProvider {
  readonly chain = "bnb" as const;
  readonly id = "etherscan-bnb";
  readonly name = "Etherscan V2 (BNB Smart Chain)";
  readonly http: HttpClient;
  /** The JSON-RPC endpoint is a different host with its own limits, so it gets its own client:
   *  an Etherscan rate-limit cooldown must not stall native-balance reads, and vice versa. */
  readonly rpcHttp: HttpClient;
  private readonly apiUrl: string;
  private readonly apiKey: string | null;
  private readonly rpcUrl: string;
  constructor(opts: { apiUrl: string; apiKey: string | null; rpcUrl: string }, fetchImpl?: typeof fetch) {
    this.apiUrl = opts.apiUrl;
    this.apiKey = opts.apiKey;
    this.rpcUrl = opts.rpcUrl;
    // Etherscan's per-key limit is a few calls per second; the head refresh fans out one call per stream.
    this.http = new HttpClient(this.id, 2, fetchImpl);
    this.rpcHttp = new HttpClient("bnb-rpc", 4, fetchImpl);
  }

  streams() {
    return Object.keys(ACTIONS);
  }

  /**
   * One Etherscan V2 `account` call. Etherscan answers most failures with HTTP 200 and
   * `status: "0"`, the real cause in `result` and only "NOTOK" in `message`, so this reads the body
   * rather than trusting the HTTP status. "No transactions found" is a real empty history; anything
   * else is an error -- in particular the free tier's refusal of chain 56 must reach the user as the
   * reason BNB has no data, not as "no transactions".
   */
  private async request(params: Record<string, string>, budget: Budget | undefined, opts: { timeoutMs?: number; maxRetries?: number } = {}): Promise<unknown> {
    const key = this.apiKey;
    if (!key) throw new ProviderError(this.id, "BNB Chain lookups need ETHERSCAN_API_KEY configured (an Etherscan key whose plan covers BNB Smart Chain)");
    const url = new URL(this.apiUrl);
    url.searchParams.set("chainid", String(BNB_CHAIN_ID));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("apikey", key);
    for (let attempt = 0; ; attempt++) {
      const { data } = await this.http.json<EsResponse<unknown>>(url.toString(), { budget, timeoutMs: opts.timeoutMs ?? 20_000, maxRetries: opts.maxRetries ?? 3 });
      if (!data || typeof data !== "object") throw new ProviderError(this.id, "Etherscan returned an unexpected response");
      if (data.status === "1") return data.result;
      if (data.status === "0" && /^No (transactions|records|token transfers) found/i.test(data.message ?? "")) return EMPTY;
      // Never echo the key, even if an upstream message ever included the request.
      const detail = String(typeof data.result === "string" && data.result ? data.result : data.message ?? "unknown error").split(key).join("[redacted]").slice(0, 200);
      if (/rate limit/i.test(detail) && !/daily/i.test(detail)) {
        // The per-second limit arrives as a 200, so HttpClient's own 429 backoff never sees it.
        this.http.coolDown("*", 1);
        if (attempt < 2 && (!budget || budget.deadline - Date.now() > 2500)) continue;
        throw new ProviderError(this.id, "Etherscan is rate limited", 1);
      }
      if (/not supported for this chain/i.test(detail)) {
        throw new ProviderError(this.id, "Etherscan refused BNB Smart Chain for this API key: its plan doesn't cover chain 56 (Etherscan's free tier excludes BNB)", 3600);
      }
      throw new ProviderError(this.id, `Etherscan: ${detail}`, /daily/i.test(detail) ? 3600 : undefined);
    }
  }

  /** An `account` list call: `request`, plus "the result really is a list of rows". */
  private async call<T>(params: Record<string, string>, budget: Budget | undefined): Promise<T[]> {
    const result = await this.request(params, budget);
    if (result === EMPTY) return [];
    if (!Array.isArray(result)) throw new ProviderError(this.id, "Etherscan returned an unexpected response");
    return result as T[];
  }

  private parseCursor(cursor: string | null): Cursor {
    if (!cursor) return { e: null, p: 1 };
    try {
      const c = JSON.parse(cursor) as Cursor;
      if ((c.e === null || Number.isSafeInteger(c.e)) && Number.isSafeInteger(c.p) && c.p >= 1) return c;
    } catch {
      /* fall through */
    }
    throw new ProviderError(this.id, "invalid BNB paging cursor");
  }

  async fetchStreamPage(address: string, stream: string, cursor: string | null, budget: Budget): Promise<StreamPage> {
    const spec = ACTIONS[stream];
    if (!spec) throw new ProviderError(this.id, `unknown stream ${stream}`);
    const a = toChecksumAddress(address);
    const cur = this.parseCursor(cursor);
    const rows = await this.call<EsTx & EsInternal & EsTokenTx>(
      {
        module: "account",
        action: spec.action,
        address: a,
        startblock: "0",
        ...(cur.e !== null ? { endblock: String(cur.e) } : {}),
        page: String(cur.p),
        offset: String(PAGE_SIZE),
        sort: "desc",
      },
      budget,
    );
    const blocks = rows.map((r) => Number(r.blockNumber)).filter(Number.isSafeInteger);
    const times = rows.map((r) => Number(r.timeStamp)).filter(Number.isSafeInteger);
    let nextCursor: string | null = null;
    let note: string | undefined;
    if (rows.length >= PAGE_SIZE && blocks.length) {
      const next = nextBnbCursor(cur, Math.min(...blocks), Math.max(...blocks));
      if ("skip" in next) {
        note = `${stream}: block ${next.skip} holds more of this address's transfers than Etherscan can page through (${MAX_WINDOW}); the rest of that block is not loaded`;
        nextCursor = next.skip > 0 ? JSON.stringify({ e: next.skip - 1, p: 1 }) : null;
      } else nextCursor = JSON.stringify(next);
    }
    return {
      transfers: spec.normalize(rows as never[]),
      nextCursor,
      oldestTime: times.length ? Math.min(...times) : null,
      newestTime: times.length ? Math.max(...times) : null,
      ...(note ? { note } : {}),
    };
  }

  fetchTransfers(address: string, opts: { before?: string | null; budget: Budget }) {
    return combinedFetch(this, address, opts.before, opts.budget);
  }

  private async rpc<T>(body: unknown, budget: Budget): Promise<T> {
    const { data } = await this.rpcHttp.json<T>(this.rpcUrl, { method: "POST", body, budget });
    return data;
  }

  /**
   * Native BNB from the RPC (`eth_getBalance`, no key); BEP-20 holdings from the address's own most
   * recent `tokentx` rows (Etherscan -- an RPC can't enumerate "every token this address holds"),
   * each then read live via `balanceOf` on the RPC, so amounts are current rather than summed history.
   * If the token side can't be read, this throws rather than return native alone: a list missing
   * every token would look like a complete (token-less) wallet.
   *
   * Coverage limit: only tokens moved in the latest 1000 BEP-20 transfers are discovered, at most
   * 200 of them (most recently active first) -- a token received once, long ago, and never moved
   * since can be missing from a very busy address's list.
   */
  async fetchBalances(address: string, budget: Budget): Promise<RawBalance[]> {
    const a = toChecksumAddress(address);
    const [nativeRes, tokenRows] = await Promise.all([
      this.rpc<{ result?: string; error?: { message: string } }>({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [a, "latest"] }, budget),
      this.call<EsTokenTx>({ module: "account", action: "tokentx", address: a, page: "1", offset: String(PAGE_SIZE), sort: "desc" }, budget),
    ]);
    if (nativeRes.error || typeof nativeRes.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(nativeRes.result)) {
      throw new ProviderError("bnb-rpc", `BNB RPC eth_getBalance failed${nativeRes.error ? `: ${nativeRes.error.message.slice(0, 120)}` : ""}`, 5);
    }
    const out: RawBalance[] = [];
    const wei = BigInt(nativeRes.result === "0x" ? "0x0" : nativeRes.result);
    if (wei > 0n) out.push({ tokenId: "native", symbol: "BNB", name: "BNB", decimals: BNB_DECIMALS, amountRaw: wei.toString(), priceCoin: NATIVE_COIN.bnb });

    const tokens = new Map<string, EsTokenTx>();
    for (const r of tokenRows) {
      const c = cs(r.contractAddress);
      if (c && !tokens.has(c)) tokens.set(c, r);
      if (tokens.size >= MAX_BALANCE_TOKENS) break;
    }
    const contracts = [...tokens.keys()];
    const data = `${BALANCE_OF}${a.slice(2).toLowerCase().padStart(64, "0")}`;
    const amounts = new Map<string, bigint>();
    for (let i = 0; i < contracts.length; i += RPC_BATCH) {
      const part = contracts.slice(i, i + RPC_BATCH);
      const res = await this.rpc<{ id: number; result?: string; error?: unknown }[]>(
        part.map((to, j) => ({ jsonrpc: "2.0", id: i + j, method: "eth_call", params: [{ to, data }, "latest"] })),
        budget,
      );
      if (!Array.isArray(res)) throw new ProviderError("bnb-rpc", "BNB RPC returned an unexpected batch response", 5);
      // Batched JSON-RPC results can come back in any order: pair by id, never by position (LESSONS.md).
      for (const r of res) {
        const contract = typeof r?.id === "number" ? contracts[r.id] : undefined;
        // A revert or an empty "0x" (not actually a token) just isn't a balance; it isn't an error either.
        if (!contract || typeof r.result !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(r.result)) continue;
        amounts.set(contract, BigInt(r.result));
      }
    }
    for (const c of contracts) {
      const amt = amounts.get(c);
      if (!amt || amt <= 0n) continue;
      const meta = tokens.get(c)!;
      out.push({ tokenId: c, symbol: meta.tokenSymbol || null, name: meta.tokenName || null, decimals: decimalsOf(meta.tokenDecimal), amountRaw: amt.toString(), priceCoin: tokenCoin("bnb", c) });
    }
    return out;
  }

  async ping() {
    try {
      // A plain balance read of the zero address: the cheapest call that still proves this key may
      // read chain 56 (the free tier fails here, with its real reason as the note).
      await this.request({ module: "account", action: "balance", address: "0x0000000000000000000000000000000000000000", tag: "latest" }, undefined, { timeoutMs: 8000, maxRetries: 0 });
      return { ok: true };
    } catch (e) {
      return { ok: false, note: e instanceof Error ? e.message : "unreachable" };
    }
  }
}
