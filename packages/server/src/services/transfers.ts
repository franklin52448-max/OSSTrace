import { chainForAddress, isAddressOnChain, isChain, normalizeAddress, type Chain, type Counterparty, type SyncStatus, type TransfersResponse } from "@osstrace/contract";
import type { Ctx } from "../context.ts";
import { budgetMs, HttpClient } from "../lib/http.ts";
import { badRequest } from "../lib/errors.ts";
import { parseTimeLast, parseTimePoint } from "../lib/time.ts";
import { mergeSync } from "../chain/sync.ts";
import { fetchSolscanTransfersBetween } from "../chain/solscan.ts";
import { FROM_IS, rowAddresses, rowToTransfer, TO_IS, TRANSFER_COLS, type TransferRow } from "../chain/store.ts";
import { LabelIndex } from "./labelIndex.ts";
import type { Param } from "../db/index.ts";

export type AddrKey = { chain: Chain; address: string };

/** `chain:address`, bare address (chain detected), or `entity:<id>` (expands to the user's entity addresses). */
export function parseAddrRef(ctx: Ctx, userId: string | null, ref: string, fallbackChain?: Chain): AddrKey[] {
  const s = ref.trim();
  if (s.startsWith("entity:")) {
    // Entities are private per-account data (ADR: anon mode) -- an anon caller has none, by construction.
    if (!userId) throw badRequest("Sign in to use a saved entity");
    const id = s.slice(7);
    return ctx.db.all<AddrKey>("SELECT chain, address FROM labels WHERE user_id = ? AND entity_id = ?", userId, id);
  }
  const i = s.indexOf(":");
  const prefix = i > 0 ? s.slice(0, i) : null;
  const m = prefix !== null && isChain(prefix);
  // A bare 0x address with no `chain:` prefix means the caller's own chain when it gave one (a BNB
  // query's own refs), and only otherwise the shape's default.
  const chain = m ? (prefix as Chain) : chainForAddress(s, fallbackChain);
  const addr = m ? s.slice(i + 1) : s;
  if (!chain || !isAddressOnChain(chain, addr)) throw badRequest(`Not a valid address: ${s.slice(0, 80)}`);
  return [{ chain, address: normalizeAddress(chain, addr) }];
}

export function parseAddress(chainParam: string, address: string): AddrKey {
  if (!isChain(chainParam)) throw badRequest("Unknown chain");
  if (!isAddressOnChain(chainParam, address)) throw badRequest("Not a valid address for this chain");
  return { chain: chainParam, address: normalizeAddress(chainParam, address) };
}

/** Anon (signed-out) depth cap, per address (ADR 0024): real access, just not unbounded -- keeps a
 * busy exchange wallet from costing this server RPC budget on behalf of someone with no account at
 * all. Connecting a wallet removes it entirely; it's enforced here (not just a frontend hint) so it
 * can't be bypassed by calling the API directly. */
export const ANON_TX_CAP = 100_000;

function countStored(ctx: Ctx, a: AddrKey): number {
  // FROM_IS/TO_IS each expand their "?" placeholder twice (addr OR owner) -- one bound param per "?".
  const row = ctx.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM transfers t WHERE t.chain = ? AND (${FROM_IS("?")} OR ${TO_IS("?")})`,
    a.chain,
    a.address,
    a.address,
    a.address,
    a.address,
  )!;
  return Number(row.n);
}

/** Sync several addresses with one shared budget; provider errors surface only if nothing can be served.
 * `anon: true` enforces ANON_TX_CAP per address -- an address already at/over the cap is skipped
 * entirely (no further provider calls spent on it) and the merged result is flagged `anonCapped`. */
export async function syncAll(
  ctx: Ctx,
  addrs: AddrKey[],
  windowFrom: number | null,
  opts: { maxRounds?: number | undefined; budgetMs?: number | undefined; anon?: boolean | undefined } = {},
): Promise<SyncStatus> {
  const uniq = [...new Map(addrs.map((a) => [`${a.chain}:${a.address}`, a])).values()].slice(0, 25);
  if (uniq.length === 0) return { state: "ready", coveredFrom: null, provider: "none" };
  const budget = budgetMs(opts.budgetMs ?? 12_000);
  // A signed-in caller (opts.anon falsy) may use a configured paid indexer for deep history, e.g.
  // Solscan on the Solana provider -- see Budget.preferIndexed's own doc comment for why.
  budget.preferIndexed = !opts.anon;
  let anonCapped = false;
  const toSync = opts.anon
    ? uniq.filter((a) => {
        const capped = countStored(ctx, a) >= ANON_TX_CAP;
        if (capped) anonCapped = true;
        return !capped;
      })
    : uniq;
  if (toSync.length === 0) return { state: "partial", coveredFrom: null, provider: "none", anonCapped: true };
  const results = await Promise.allSettled(toSync.map((a) => ctx.sync.ensureSynced(a.chain, a.address, { windowFrom, budget, maxRounds: opts.maxRounds })));
  const ok = results.filter((r): r is PromiseFulfilledResult<SyncStatus> => r.status === "fulfilled").map((r) => r.value);
  if (ok.length === 0) throw (results[0] as PromiseRejectedResult).reason;
  const failed = results.length - ok.length;
  const merged = { ...mergeSync(ok), ...(anonCapped ? { anonCapped: true } : {}) };
  if (failed > 0) return { ...merged, state: "error", message: [merged.message, `${failed} address(es) could not be loaded from the provider`].filter(Boolean).join("; ") };
  return merged;
}

export type TransferQuery = {
  base: string[];
  counterparties: string[];
  flow: "in" | "out" | "all" | "self";
  usdGte?: number | undefined;
  usdLte?: number | undefined;
  valueGte?: number | undefined;
  valueLte?: number | undefined;
  tokens: string[];
  chain?: Chain | undefined;
  timeLast?: string | undefined;
  timeGte?: string | undefined;
  timeLte?: string | undefined;
  sortKey: "time" | "value" | "usd";
  sortDir: "asc" | "desc";
  limit: number;
  cursor?: string | undefined;
};

type Cursor = { k: string; v: number; s: number };
const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decodeCursor(s: string, sortKey: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Cursor;
    if (c.k !== sortKey || typeof c.v !== "number" || typeof c.s !== "number") throw new Error();
    return c;
  } catch {
    throw badRequest("Invalid cursor");
  }
}

/** Builds `(from IN set OR from_owner IN set)` style predicates over a list of addresses per chain. */
function inSet(side: "from" | "to", addrs: AddrKey[], params: Param[]): string {
  if (addrs.length === 0) return "0 = 1";
  const byChain = new Map<Chain, string[]>();
  for (const a of addrs) byChain.set(a.chain, [...(byChain.get(a.chain) ?? []), a.address]);
  const parts: string[] = [];
  for (const [chain, list] of byChain) {
    const ph = list.map(() => "?").join(",");
    parts.push(`(t.chain = ? AND (t.${side}_addr IN (${ph}) OR t.${side}_owner IN (${ph})))`);
    params.push(chain, ...list, ...list);
  }
  return `(${parts.join(" OR ")})`;
}

export function windowOf(q: { timeLast?: string | undefined; timeGte?: string | undefined; timeLte?: string | undefined }) {
  const gte = parseTimePoint(q.timeGte ?? null);
  const lte = parseTimePoint(q.timeLte ?? null);
  const last = parseTimeLast(q.timeLast);
  const from = gte ?? (last !== null ? Math.floor(Date.now() / 1000) - last : null);
  if (q.timeGte && gte === null) throw badRequest("timeGte must be ISO-8601 or epoch milliseconds");
  if (q.timeLte && lte === null) throw badRequest("timeLte must be ISO-8601 or epoch milliseconds");
  if (q.timeLast && q.timeLast !== "all" && last === null) throw badRequest("timeLast must look like 1h, 24h, 7d, 30d, 1y or all");
  return { from, to: lte };
}

export async function queryTransfers(ctx: Ctx, userId: string | null, q: TransferQuery): Promise<TransfersResponse> {
  const base = q.base.flatMap((b) => parseAddrRef(ctx, userId, b, q.chain)).filter((a) => !q.chain || a.chain === q.chain);
  const cps = q.counterparties.flatMap((b) => parseAddrRef(ctx, userId, b, q.chain));
  if (q.base.length === 0) throw badRequest("At least one base address is required (token-wide queries are not supported in v1)");
  const { from, to } = windowOf(q);
  const cursor = q.cursor ? decodeCursor(q.cursor, q.sortKey) : null;

  // Sync: the window if one is given; when paging by time past the cached range, backfill past the cursor.
  let windowFrom = from;
  if (windowFrom === null && cursor && q.sortKey === "time" && q.sortDir === "desc") windowFrom = cursor.v - 1;
  const sync = base.length
    ? await syncAll(ctx, base, windowFrom, { maxRounds: windowFrom === null ? 0 : undefined, anon: !userId })
    : { state: "ready" as const, coveredFrom: null, provider: "none" };

  // A specific (base, counterparty) pair -- exactly what Find Connections and "narrow by
  // counterparty" send -- can sit thousands of rows deep in a busy wallet's general history (a
  // real 347-token-account wallet needed 500+ unrelated rows before a known counterparty's
  // transfers appeared), so the chronological sync above can genuinely never reach them within any
  // real budget. Solscan's own from/to filter answers this directly instead. Signed-in only (same
  // Budget.preferIndexed gate as the general sync), Solana only (Solscan has no Ethereum data),
  // and only for exactly one base + one counterparty (the pairwise shape this is for) -- a broader
  // query already has the general sync covering it reasonably.
  if (userId && ctx.config.solscanApiKey && base.length === 1 && cps.length === 1 && base[0]!.chain === "solana" && cps[0]!.chain === "solana") {
    try {
      const found = await fetchSolscanTransfersBetween(new HttpClient("solscan-pair", 2), ctx.config.solscanApiKey, base[0]!.address, cps[0]!.address, budgetMs(8000));
      ctx.store.upsert(found);
    } catch {
      // The general sync above already ran; a failure here just means this shortcut didn't help,
      // not that the query itself should fail.
    }
  }

  // inSet appends its params as it renders, so predicates are built in SQL text order.
  const conds: string[] = [];
  const p2: Param[] = [];
  const fB = () => inSet("from", base, p2);
  const tB = () => inSet("to", base, p2);
  // `IS NOT TRUE` (not NOT): owner columns are often NULL and NOT NULL would drop the row.
  if (q.flow === "in") conds.push(`(${tB()} AND ${fB()} IS NOT TRUE)`);
  else if (q.flow === "out") conds.push(`(${fB()} AND ${tB()} IS NOT TRUE)`);
  else if (q.flow === "self") conds.push(`(${fB()} AND ${tB()})`);
  else conds.push(`(${fB()} OR ${tB()})`);
  if (cps.length) conds.push(`(${inSet("from", cps, p2)} OR ${inSet("to", cps, p2)})`);
  if (q.chain) conds.push("t.chain = ?"), p2.push(q.chain);
  if (from !== null) conds.push("t.block_time >= ?"), p2.push(from);
  if (to !== null) conds.push("t.block_time <= ?"), p2.push(to);
  if (q.usdGte !== undefined) conds.push("t.usd >= ?"), p2.push(q.usdGte);
  if (q.usdLte !== undefined) conds.push("t.usd <= ?"), p2.push(q.usdLte);
  if (q.valueGte !== undefined) conds.push("t.amount_num >= ?"), p2.push(q.valueGte);
  if (q.valueLte !== undefined) conds.push("t.amount_num <= ?"), p2.push(q.valueLte);
  if (q.tokens.length) {
    const toks = q.tokens.map((t) => (/^0x[0-9a-fA-F]{40}$/.test(t) ? normalizeAddress("ethereum", t) : t));
    conds.push(`t.token_id IN (${toks.map(() => "?").join(",")})`);
    p2.push(...toks);
  }
  const whereSql = conds.join(" AND ");

  const col = q.sortKey === "time" ? "t.block_time" : q.sortKey === "value" ? "t.amount_num" : "COALESCE(t.usd, -1)";
  const dir = q.sortDir === "asc" ? "ASC" : "DESC";
  const cmp = q.sortDir === "asc" ? ">" : "<";
  const pageParams = [...p2];
  let pageWhere = whereSql;
  if (cursor) {
    pageWhere += ` AND (${col} ${cmp} ? OR (${col} = ? AND t.seq ${cmp} ?))`;
    pageParams.push(cursor.v, cursor.v, cursor.s);
  }
  const rows = ctx.db.all<TransferRow & { sortv: number }>(
    `SELECT ${TRANSFER_COLS}, ${col} AS sortv FROM transfers t WHERE ${pageWhere} ORDER BY ${col} ${dir}, t.seq ${dir} LIMIT ?`,
    ...pageParams,
    q.limit + 1,
  );
  const more = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  const countRow = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM transfers t WHERE ${whereSql} LIMIT 10001) x`, ...p2)!;
  const n = Number(countRow.n);
  const ix = LabelIndex.load(ctx.db, userId, rowAddresses(page));
  const last = page[page.length - 1];
  return {
    transfers: page.map((r) => rowToTransfer(r, ix)),
    nextCursor: more && last ? encodeCursor({ k: q.sortKey, v: Number(last.sortv), s: Number(last.seq) }) : null,
    count: { value: Math.min(n, 10_000), capped: n > 10_000 },
    sync,
  };
}

/** Counterparties of one address from the cache, grouped by owner wallet (else address), per flow. */
export function counterpartiesFor(
  ctx: Ctx,
  userId: string | null,
  a: AddrKey,
  opts: { flow: "in" | "out" | "all"; limit: number; from: number | null; to: number | null; usdGte?: number | undefined },
): Counterparty[] {
  const out: Counterparty[] = [];
  const flows: ("in" | "out")[] = opts.flow === "all" ? ["in", "out"] : [opts.flow];
  for (const flow of flows) {
    const self = flow === "in" ? TO_IS("?") : FROM_IS("?");
    const other = flow === "in" ? "COALESCE(t.from_owner, t.from_addr)" : "COALESCE(t.to_owner, t.to_addr)";
    const notSelf = flow === "in" ? `${FROM_IS("?")} IS NOT TRUE` : `${TO_IS("?")} IS NOT TRUE`;
    const params: Param[] = [a.chain, a.address, a.address, a.address, a.address];
    let sql = `SELECT ${other} AS cp, SUM(COALESCE(t.usd, 0)) AS usd, COUNT(*) AS n FROM transfers t
               WHERE t.chain = ? AND ${self} AND ${notSelf}`;
    if (opts.from !== null) (sql += " AND t.block_time >= ?"), params.push(opts.from);
    if (opts.to !== null) (sql += " AND t.block_time <= ?"), params.push(opts.to);
    sql += ` GROUP BY ${other}`;
    if (opts.usdGte !== undefined) (sql += " HAVING SUM(COALESCE(t.usd, 0)) >= ?"), params.push(opts.usdGte);
    sql += " ORDER BY usd DESC, n DESC LIMIT ?";
    params.push(opts.limit);
    const rows = ctx.db.all<{ cp: string; usd: number; n: number }>(sql, ...params);
    const ix = LabelIndex.load(ctx.db, userId, rows.map((r) => ({ chain: a.chain, address: r.cp })));
    for (const r of rows) out.push({ address: ix.info(a.chain, r.cp), usd: Number(r.usd), transactionCount: Number(r.n), flow, chains: [a.chain] });
  }
  return out;
}
