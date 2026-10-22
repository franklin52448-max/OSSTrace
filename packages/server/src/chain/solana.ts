import { ProviderError } from "../lib/errors.ts";
import { HttpClient, type Budget } from "../lib/http.ts";
import { isPositiveIntString } from "./amount.ts";
import { combinedFetch, type ChainProvider, type RawBalance, type RawTransfer, type StreamPage } from "./types.ts";

// Shapes of Solana JSON-RPC jsonParsed responses (only what the server reads). Recorded: tests/fixtures/solana/.
type ParsedIx = { program?: string; programId: string; parsed?: unknown; stackHeight?: number | null };
type TokenBal = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } };
export type SolTx = {
  slot: number;
  blockTime: number | null;
  transaction: { signatures: string[]; message: { accountKeys: ({ pubkey: string } | string)[]; instructions: ParsedIx[] } };
  meta: {
    err: unknown;
    innerInstructions?: { index: number; instructions: ParsedIx[] }[] | null;
    preTokenBalances?: TokenBal[] | null;
    postTokenBalances?: TokenBal[] | null;
  } | null;
};
type SigInfo = { signature: string; slot: number; blockTime: number | null; err: unknown };
export type OwnedTokenAccount = { pubkey: string; mint: string; amountRaw: string; decimals: number };
type MergeSource = {
  a: string;
  kind: "wallet" | "token";
  before: string | null;
  /** Buffered, not yet processed signatures (newest first). */
  buf: { s: string; t: number; e: boolean }[];
  /** No signatures beyond `buf` exist. */
  ended: boolean;
  /** Oldest blockTime processed so far for this source. */
  cov: number | null;
  dropped?: boolean;
};
type MergeState = { v: 2; src: MergeSource[]; follow?: string };
export type SolanaProviderOptions = {
  /** Max token accounts followed per wallet (default 4 public / 25 custom; 0 = wallet signatures only). */
  maxTokenAccounts?: number;
  /** Token accounts of this wallet seen in cached transfers, most recent first. */
  recentTokenAccounts?: (wallet: string) => string[];
  /** USD prices already cached locally, by mint (no network). */
  cachedUsdPrices?: (mints: string[]) => Map<string, number>;
};
const formatUnitsLossy = (raw: string, decimals: number) => (decimals > 0 ? Number(raw) / 10 ** decimals : Number(raw));

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SOL_COIN = "coingecko:solana";

type TokenAcct = { mint: string; owner: string | null; decimals: number };

/**
 * Derive SOL (system transfer / transferWithSeed) and SPL (transfer / transferChecked, Token and Token-2022)
 * transfers from one jsonParsed transaction, top-level and inner instructions, in execution order.
 * Token accounts are mapped to their owner wallet via pre/postTokenBalances. Id = `<signature>_<ordinal>`.
 * Failed transactions move nothing and yield no transfers.
 */
export function normalizeSolanaTx(tx: SolTx): RawTransfer[] {
  if (!tx?.meta || tx.meta.err) return [];
  const sig = tx.transaction.signatures[0];
  const time = tx.blockTime;
  if (!sig || time == null) return [];
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const accts = new Map<string, TokenAcct>();
  for (const b of [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])]) {
    const pk = keys[b.accountIndex];
    if (!pk) continue;
    const prev = accts.get(pk);
    accts.set(pk, { mint: b.mint, owner: b.owner ?? prev?.owner ?? null, decimals: b.uiTokenAmount.decimals });
  }
  const inner = new Map<number, ParsedIx[]>();
  for (const g of tx.meta.innerInstructions ?? []) inner.set(g.index, g.instructions);

  const out: RawTransfer[] = [];
  let ordinal = 0;
  const emit = (ix: ParsedIx) => {
    const p = ix.parsed as { type?: string; info?: Record<string, unknown> } | undefined;
    if (!p || typeof p !== "object" || !p.info) return;
    const info = p.info;
    const common = { chain: "solana" as const, txHash: sig, blockNumber: tx.slot, blockTime: time };
    if (ix.program === "system" && (p.type === "transfer" || p.type === "transferWithSeed")) {
      const lamports = info.lamports;
      const amountRaw = typeof lamports === "number" ? BigInt(lamports).toString() : typeof lamports === "string" ? lamports : null;
      const from = info.source as string | undefined;
      const to = info.destination as string | undefined;
      if (!from || !to || !isPositiveIntString(amountRaw)) return;
      out.push({
        ...common,
        id: `${sig}_${ordinal++}`,
        from,
        to,
        fromOwner: null,
        toOwner: null,
        tokenId: "native",
        tokenSymbol: "SOL",
        tokenName: "Solana",
        tokenDecimals: 9,
        tokenStandard: "native",
        amountRaw,
        priceCoin: SOL_COIN,
      });
      return;
    }
    if ((ix.program === "spl-token" || ix.programId === TOKEN_PROGRAM || ix.programId === TOKEN_2022_PROGRAM) && (p.type === "transfer" || p.type === "transferChecked")) {
      const from = info.source as string | undefined;
      const to = info.destination as string | undefined;
      if (!from || !to) return;
      const src = accts.get(from);
      const dst = accts.get(to);
      const tokenAmount = info.tokenAmount as { amount?: string; decimals?: number } | undefined;
      const mint = (info.mint as string | undefined) ?? src?.mint ?? dst?.mint;
      const amountRaw = (info.amount as string | undefined) ?? tokenAmount?.amount;
      const decimals = tokenAmount?.decimals ?? src?.decimals ?? dst?.decimals ?? null;
      // Without a mint we cannot say what moved; skip rather than guess.
      if (!mint || !isPositiveIntString(amountRaw)) return;
      out.push({
        ...common,
        id: `${sig}_${ordinal++}`,
        from,
        to,
        fromOwner: src?.owner ?? null,
        toOwner: dst?.owner ?? null,
        tokenId: mint,
        tokenSymbol: null,
        tokenName: null,
        tokenDecimals: decimals,
        tokenStandard: "spl",
        amountRaw,
        priceCoin: `solana:${mint}`,
      });
    }
  };
  tx.transaction.message.instructions.forEach((ix, i) => {
    emit(ix);
    for (const sub of inner.get(i) ?? []) emit(sub);
  });
  return out;
}

export const touches = (t: RawTransfer, address: string) =>
  t.from === address || t.to === address || t.fromOwner === address || t.toOwner === address;

type RpcResp<T> = { result?: T; error?: { code: number; message: string } };

export class SolanaRpcProvider implements ChainProvider {
  readonly chain = "solana" as const;
  readonly id = "solana-rpc";
  readonly name: string;
  readonly http: HttpClient;
  private readonly sigPage: number;
  private readonly tokenSigPage: number;
  private readonly txConcurrency: number;
  private readonly maxTokenAccounts: number;
  private tokenAcctCache = new Map<string, { at: number; list: OwnedTokenAccount[] }>();
  private readonly url: string;
  private readonly opts: SolanaProviderOptions;

  constructor(url: string, custom: boolean, fetchImpl?: typeof fetch, opts: SolanaProviderOptions = {}) {
    this.url = url;
    this.opts = opts;
    this.name = custom ? "Solana JSON-RPC (custom endpoint)" : "Solana JSON-RPC (public mainnet-beta)";
    // The public endpoint allows ~10 calls per 10 s per IP *per method* (x-ratelimit-method-limit: 10 for
    // getTransaction, getSignaturesForAddress and getTokenAccountsByOwner, observed 2026-10-22), so pages and the
    // number of token accounts followed are small there. A keyed RPC gets bigger pages and more parallelism.
    this.sigPage = custom ? 50 : 10;
    this.tokenSigPage = custom ? 25 : 10;
    this.txConcurrency = custom ? 6 : 2;
    this.maxTokenAccounts = opts.maxTokenAccounts ?? (custom ? 25 : 4);
    this.http = new HttpClient(this.id, this.txConcurrency, fetchImpl);
  }

  async rpc<T>(method: string, params: unknown[], budget?: Budget): Promise<T> {
    const { data, headers } = await this.http.json<RpcResp<T>>(this.url, {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method, params },
      budget,
      cooldownKey: method,
      timeoutMs: 20_000,
    });
    const remaining = Number(headers.get("x-ratelimit-method-remaining"));
    if (headers.has("x-ratelimit-method-remaining") && Number.isFinite(remaining) && remaining <= 1) this.http.coolDown(method, 2);
    if (data.error) {
      if (data.error.code === 429 || /rate|too many/i.test(data.error.message)) {
        this.http.coolDown(method, 5);
        throw new ProviderError(this.id, "Solana RPC is rate limited", 5);
      }
      throw new ProviderError(this.id, `Solana RPC error ${data.error.code}`);
    }
    return data.result as T;
  }

  streams() {
    return ["signatures"];
  }

  /** All token accounts (Token + Token-2022) owned by the wallet with a non-zero balance. Cached 10 min. */
  async ownedTokenAccounts(wallet: string, budget: Budget): Promise<OwnedTokenAccount[]> {
    const hit = this.tokenAcctCache.get(wallet);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.list;
    type TA = { value: { pubkey: string; account: { data: { parsed?: { info?: { mint: string; tokenAmount: { amount: string; decimals: number } } } } } }[] };
    const [a, b] = await Promise.all(
      [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((programId) =>
        this.rpc<TA>("getTokenAccountsByOwner", [wallet, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }], budget),
      ),
    );
    const list: OwnedTokenAccount[] = [];
    for (const acc of [...(a?.value ?? []), ...(b?.value ?? [])]) {
      const info = acc.account?.data?.parsed?.info;
      if (!info?.mint || !/^\d+$/.test(info.tokenAmount?.amount ?? "")) continue;
      list.push({ pubkey: acc.pubkey, mint: info.mint, amountRaw: info.tokenAmount.amount, decimals: info.tokenAmount.decimals });
    }
    this.tokenAcctCache.set(wallet, { at: Date.now(), list });
    return list;
  }

  /**
   * Which token accounts to follow, best first: (1) accounts the cache has recently seen this wallet's tokens move
   * through (most recent first), (2) accounts holding the most USD value at locally cached prices, (3) the rest in
   * RPC order. Probing recency of every account costs one RPC call each, which the public endpoint cannot afford
   * for wallets with thousands of token accounts.
   */
  async pickTokenAccounts(wallet: string, budget: Budget): Promise<{ picked: string[]; total: number; note?: string }> {
    if (this.maxTokenAccounts <= 0) return { picked: [], total: 0 };
    let owned: OwnedTokenAccount[];
    try {
      owned = await this.ownedTokenAccounts(wallet, budget);
    } catch (e) {
      return { picked: [], total: 0, note: `token accounts not loaded (${e instanceof Error ? e.message : "error"}); incoming SPL transfers may be missing` };
    }
    const nonzero = owned.filter((o) => !/^0+$/.test(o.amountRaw));
    const ownedSet = new Set(owned.map((o) => o.pubkey));
    const picked: string[] = [];
    const add = (pk: string) => {
      if (picked.length < this.maxTokenAccounts && pk !== wallet && ownedSet.has(pk) && !picked.includes(pk)) picked.push(pk);
    };
    for (const pk of this.opts.recentTokenAccounts?.(wallet) ?? []) add(pk);
    if (picked.length < this.maxTokenAccounts && this.opts.cachedUsdPrices) {
      const prices = this.opts.cachedUsdPrices(nonzero.map((o) => o.mint));
      const valued = nonzero
        .map((o) => ({ pk: o.pubkey, usd: prices.has(o.mint) ? Number(formatUnitsLossy(o.amountRaw, o.decimals)) * prices.get(o.mint)! : -1 }))
        .filter((v) => v.usd > 0)
        .sort((x, y) => y.usd - x.usd);
      for (const v of valued) add(v.pk);
    }
    for (const o of nonzero) add(o.pubkey);
    return { picked, total: nonzero.length };
  }

  /**
   * One page of the wallet's history = the wallet's own signatures merged with the signatures of the token
   * accounts it owns (an incoming SPL transfer often only references the token account, never the wallet).
   * Signatures are buffered per source, deduped by signature and processed newest-first by blockTime. Only
   * signatures newer than every source's unfetched frontier are processed, so coverage stays exact; the cursor
   * holds each source's buffer and `before` signature.
   */
  async fetchStreamPage(wallet: string, _stream: string, cursor: string | null, budget: Budget): Promise<StreamPage> {
    let state: MergeState;
    const notes: string[] = [];
    if (cursor && cursor.startsWith("{")) state = JSON.parse(cursor) as MergeState;
    else {
      const { picked, total, note } = await this.pickTokenAccounts(wallet, budget);
      if (note) notes.push(note);
      const src = (a: string, kind: "wallet" | "token"): MergeSource => ({ a, kind, before: null, buf: [], ended: false, cov: null });
      state = { v: 2, src: [src(wallet, "wallet"), ...picked.map((a) => src(a, "token"))] };
      if (total > picked.length) state.follow = `incoming SPL transfers are tracked for ${picked.length} of ${total} token accounts (RPC rate limits)`;
      // Legacy cursor (plain signature from the wallet-only version): resume the wallet source from it.
      if (cursor) state.src[0]!.before = cursor;
    }

    // 1. Refill empty buffers (wallet first; a token source that cannot be fetched is dropped with a note).
    for (const s of state.src) {
      if (s.ended || s.buf.length > 0) continue;
      try {
        const limit = s.kind === "wallet" ? this.sigPage : this.tokenSigPage;
        const sigs = await this.rpc<SigInfo[]>(
          "getSignaturesForAddress",
          [s.a, { limit, commitment: "finalized", ...(s.before ? { before: s.before } : {}) }],
          budget,
        );
        if (!Array.isArray(sigs)) throw new ProviderError(this.id, "Solana RPC returned an unexpected response");
        let lastT = s.cov ?? Math.floor(Date.now() / 1000);
        s.buf = sigs.map((x) => {
          lastT = x.blockTime ?? lastT;
          return { s: x.signature, t: lastT, e: !!x.err };
        });
        if (sigs.length) s.before = sigs[sigs.length - 1]!.signature;
        if (sigs.length < limit) s.ended = true;
      } catch (e) {
        if (s.kind === "wallet") throw e;
        notes.push(`token account ${s.a.slice(0, 6)}… skipped this page (${e instanceof Error ? e.message : "error"})`);
        s.dropped = true;
      }
    }
    const live = state.src.filter((s) => !s.dropped);

    // 2. Frontier: below this time some source may still hold signatures we have not seen yet.
    const frontier = (srcs: MergeSource[]) => {
      let f = -Infinity;
      for (const s of srcs) {
        if (s.ended) continue; // everything left for this source is already buffered
        const edge = s.buf.length ? s.buf[s.buf.length - 1]!.t : s.cov ?? Infinity;
        f = Math.max(f, edge);
      }
      return f;
    };
    const boundary = frontier(live);
    const seen = new Set<string>();
    const cands: { s: string; t: number; e: boolean }[] = [];
    for (const s of live) for (const x of s.buf) if (x.t >= boundary && !seen.has(x.s)) seen.add(x.s), cands.push(x);
    cands.sort((x, y) => y.t - x.t);

    // 3. Fetch transactions newest-first until done or the budget stops us.
    const results = new Map<string, SolTx | null>();
    let failure: unknown = null;
    let next = 0;
    const worker = async () => {
      while (next < cands.length && !failure) {
        const c = cands[next++]!;
        if (c.e) {
          results.set(c.s, null); // failed tx moves nothing
          continue;
        }
        if (Date.now() > budget.deadline - 500) {
          failure = new ProviderError(this.id, "budget", 1);
          return;
        }
        try {
          results.set(
            c.s,
            await this.rpc<SolTx | null>("getTransaction", [c.s, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "finalized" }], budget),
          );
        } catch (e) {
          failure = e;
        }
      }
    };
    await Promise.all(Array.from({ length: this.txConcurrency }, worker));
    // Keep only the newest-first prefix that completed, so nothing newer is left behind.
    let done = 0;
    while (done < cands.length && results.has(cands[done]!.s)) done++;
    const processed = cands.slice(0, done);
    if (processed.length === 0 && cands.length > 0) {
      if (failure instanceof ProviderError && failure.message !== "budget") throw failure;
      throw new ProviderError(this.id, "Solana RPC is rate limited", this.http.cooldownSec("getTransaction") || 5);
    }
    const doneSet = new Set(processed.map((p) => p.s));
    for (const s of state.src) {
      const removed = s.buf.filter((x) => doneSet.has(x.s));
      if (removed.length) s.cov = Math.min(s.cov ?? Infinity, ...removed.map((x) => x.t));
      s.buf = s.buf.filter((x) => !doneSet.has(x.s));
    }
    if (done < cands.length) notes.push("request budget reached; older signatures load on later requests");
    if (state.follow) notes.unshift(state.follow);

    const transfers: RawTransfer[] = [];
    for (const p of processed) {
      const tx = results.get(p.s);
      if (tx) transfers.push(...normalizeSolanaTx(tx).filter((t) => touches(t, wallet)));
    }
    // Drop sources that failed this round from the cursor: they restart on the next head refresh.
    state.src = state.src.filter((s) => !s.dropped);
    const remaining = state.src.filter((s) => !(s.ended && s.buf.length === 0));
    // Covered back to: the newest still-unprocessed signature, or a source's unfetched frontier.
    let covered = -Infinity;
    for (const s of remaining) covered = Math.max(covered, s.buf.length ? s.buf[0]!.t : s.cov ?? Infinity);
    const times = processed.map((p) => p.t);
    const oldestProcessed = times.length ? Math.min(...times) : null;
    return {
      transfers,
      nextCursor: remaining.length ? JSON.stringify(state) : null,
      oldestTime: remaining.length ? (Number.isFinite(covered) ? covered : oldestProcessed) : oldestProcessed,
      newestTime: times.length ? Math.max(...times) : null,
      ...(notes.length ? { note: notes.join("; ") } : {}),
    };
  }

  fetchTransfers(address: string, opts: { before?: string | null; budget: Budget }) {
    return combinedFetch(this, address, opts.before, opts.budget);
  }

  async fetchBalances(address: string, budget: Budget): Promise<RawBalance[]> {
    type TA = { value: { pubkey: string; account: { data: { parsed?: { info?: { mint: string; tokenAmount: { amount: string; decimals: number } } } } } }[] };
    const [lamports, a, b] = await Promise.all([
      this.rpc<{ value: number }>("getBalance", [address, { commitment: "confirmed" }], budget),
      this.rpc<TA>("getTokenAccountsByOwner", [address, { programId: TOKEN_PROGRAM }, { encoding: "jsonParsed", commitment: "confirmed" }], budget),
      this.rpc<TA>("getTokenAccountsByOwner", [address, { programId: TOKEN_2022_PROGRAM }, { encoding: "jsonParsed", commitment: "confirmed" }], budget),
    ]);
    return normalizeSolanaBalances(lamports?.value ?? 0, [...(a?.value ?? []), ...(b?.value ?? [])]);
  }

  async ping() {
    try {
      await this.rpc<string>("getHealth", [], { deadline: Date.now() + 8000 });
      return { ok: true };
    } catch (e) {
      return { ok: false, note: e instanceof Error ? e.message : "unreachable" };
    }
  }
}

export function normalizeSolanaBalances(
  lamports: number,
  accounts: { account: { data: { parsed?: { info?: { mint: string; tokenAmount: { amount: string; decimals: number } } } } } }[],
): RawBalance[] {
  const out: RawBalance[] = [];
  if (lamports > 0) out.push({ tokenId: "native", symbol: "SOL", name: "Solana", decimals: 9, amountRaw: BigInt(lamports).toString(), priceCoin: SOL_COIN });
  const byMint = new Map<string, { raw: bigint; decimals: number }>();
  for (const acc of accounts) {
    const info = acc.account?.data?.parsed?.info;
    if (!info?.mint || !/^\d+$/.test(info.tokenAmount?.amount ?? "")) continue;
    const prev = byMint.get(info.mint);
    byMint.set(info.mint, { raw: (prev?.raw ?? 0n) + BigInt(info.tokenAmount.amount), decimals: info.tokenAmount.decimals });
  }
  for (const [mint, v] of byMint) {
    if (v.raw === 0n) continue;
    out.push({ tokenId: mint, symbol: null, name: null, decimals: v.decimals, amountRaw: v.raw.toString(), priceCoin: `solana:${mint}` });
  }
  return out;
}
