/** Pure filter -> query mapping and row shaping for the data panels. */
import type { AddressInfo, Chain, Counterparty, CounterpartiesQuery, EntityRef, Transfer, TransfersQuery } from "@osstrace/contract";

export type TimePreset = "1d" | "7d" | "30d" | "90d" | "1y" | "all";
export const TIME_PRESETS: { value: TimePreset; label: string }[] = [
  { value: "1d", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "1y", label: "1y" },
  { value: "all", label: "All time" },
];

export const subjectKey = (chain: Chain, address: string) => `${chain}:${address}`;

// ---------- counterparties ----------
export type CounterpartyFilter = {
  flow: "all" | "in" | "out";
  timeLast: TimePreset;
  usdGte: number | null;
  group: boolean;
  sortKey: "usd" | "tx";
  sortDir: "asc" | "desc";
};

export const DEFAULT_COUNTERPARTY_FILTER: CounterpartyFilter = { flow: "all", timeLast: "7d", usdGte: null, group: false, sortKey: "usd", sortDir: "desc" };

/** Fetch limit per direction; rows are paged client-side (10 per page). */
export const COUNTERPARTY_FETCH_LIMIT = 100;

/** One request per direction (in and out), merged client-side for "all". */
export function counterpartiesQuery(f: CounterpartyFilter, flow: "in" | "out"): CounterpartiesQuery {
  const q: CounterpartiesQuery = { flow, limit: COUNTERPARTY_FETCH_LIMIT };
  if (f.timeLast !== "all") q.timeLast = f.timeLast;
  if (f.usdGte != null && f.usdGte > 0) q.usdGte = f.usdGte;
  return q;
}

export type DirStats = { usdIn: number; txIn: number; usdOut: number; txOut: number };

export type CounterpartyRow =
  | { kind: "address"; key: string; address: AddressInfo; usd: number; transactionCount: number; chains: Chain[]; stats: DirStats }
  | { kind: "entity"; key: string; entity: EntityRef; members: AddressInfo[]; usd: number; transactionCount: number; chains: Chain[]; stats: DirStats };

/** Owner wallet for Solana token accounts, else the address itself. */
export const rowAddress = (a: AddressInfo): AddressInfo => a.ownerAddress ?? a;
export const rowKey = (a: AddressInfo) => {
  const r = rowAddress(a);
  return subjectKey(r.chain, r.address);
};

const emptyStats = (): DirStats => ({ usdIn: 0, txIn: 0, usdOut: 0, txOut: 0 });

export function counterpartyRows(args: { inRows: Counterparty[]; outRows: Counterparty[]; flow: CounterpartyFilter["flow"]; base: { chain: Chain; address: string }; group: boolean; sortKey: CounterpartyFilter["sortKey"]; sortDir: CounterpartyFilter["sortDir"] }): CounterpartyRow[] {
  const { inRows, outRows, flow, base, group, sortKey, sortDir } = args;
  const baseKey = subjectKey(base.chain, base.address).toLowerCase();
  const map = new Map<string, Extract<CounterpartyRow, { kind: "address" }>>();
  const add = (c: Counterparty, dir: "in" | "out") => {
    const key = rowKey(c.address);
    if (key.toLowerCase() === baseKey) return;
    let r = map.get(key);
    if (!r) {
      const addr = rowAddress(c.address);
      r = { kind: "address", key, address: addr.entity || addr.label ? addr : { ...addr, entity: addr.entity ?? c.address.entity, label: addr.label ?? c.address.label }, usd: 0, transactionCount: 0, chains: [], stats: emptyStats() };
      map.set(key, r);
    }
    if (dir === "in") {
      r.stats.usdIn += c.usd;
      r.stats.txIn += c.transactionCount;
    } else {
      r.stats.usdOut += c.usd;
      r.stats.txOut += c.transactionCount;
    }
    if (flow === "all" || flow === dir) {
      r.usd += c.usd;
      r.transactionCount += c.transactionCount;
    }
    for (const ch of c.chains) if (!r.chains.includes(ch)) r.chains.push(ch);
  };
  for (const c of inRows) add(c, "in");
  for (const c of outRows) add(c, "out");
  let rows: CounterpartyRow[] = [...map.values()].filter((r) => r.transactionCount > 0 || r.usd > 0);

  if (group) {
    const byEntity = new Map<string, Extract<CounterpartyRow, { kind: "entity" }>>();
    const out: CounterpartyRow[] = [];
    for (const r of rows) {
      const ent = r.kind === "address" ? r.address.entity : null;
      if (!ent || r.kind !== "address") {
        out.push(r);
        continue;
      }
      let g = byEntity.get(ent.id);
      if (!g) {
        g = { kind: "entity", key: `entity:${ent.id}`, entity: ent, members: [], usd: 0, transactionCount: 0, chains: [], stats: emptyStats() };
        byEntity.set(ent.id, g);
        out.push(g);
      }
      g.members.push(r.address);
      g.usd += r.usd;
      g.transactionCount += r.transactionCount;
      g.stats.usdIn += r.stats.usdIn;
      g.stats.txIn += r.stats.txIn;
      g.stats.usdOut += r.stats.usdOut;
      g.stats.txOut += r.stats.txOut;
      for (const ch of r.chains) if (!g.chains.includes(ch)) g.chains.push(ch);
    }
    rows = out;
  }
  const sign = sortDir === "asc" ? 1 : -1;
  const val = (r: CounterpartyRow) => (sortKey === "usd" ? r.usd : r.transactionCount);
  return rows.sort((a, b) => sign * (val(a) - val(b)) || a.key.localeCompare(b.key));
}

export const paginate = <T,>(rows: T[], page: number, size: number) => rows.slice(page * size, page * size + size);
export const pageCount = (n: number, size: number) => Math.max(1, Math.ceil(n / size));

// ---------- transfers ----------
export type TransferFilter = {
  flow: "all" | "in" | "out" | "self";
  usdGte: number | null;
  usdLte: number | null;
  tokens: string[] | null;
  timeLast: TimePreset;
  sortKey: "time" | "value" | "usd";
  sortDir: "asc" | "desc";
  limit: number;
};

export const DEFAULT_TRANSFER_FILTER: TransferFilter = { flow: "all", usdGte: 1, usdLte: null, tokens: null, timeLast: "all", sortKey: "time", sortDir: "desc", limit: 25 };

export function transfersQuery(args: { base: string[]; counterparties?: string[] | null; filter: TransferFilter; cursor?: string | null }): TransfersQuery {
  const { base, counterparties, filter: f, cursor } = args;
  const q: TransfersQuery = { base, flow: f.flow, sortKey: f.sortKey, sortDir: f.sortDir, limit: f.limit };
  if (counterparties?.length) q.counterparties = counterparties;
  if (f.usdGte != null && f.usdGte > 0) q.usdGte = f.usdGte;
  if (f.usdLte != null) q.usdLte = f.usdLte;
  if (f.tokens?.length) q.tokens = f.tokens;
  if (f.timeLast !== "all") q.timeLast = f.timeLast;
  if (cursor) q.cursor = cursor;
  return q;
}

/** Shape a TransfersQuery for `api()`'s `query` option (arrays become repeated keys). */
export function toSearchParams(q: TransfersQuery | CounterpartiesQuery): Record<string, string | number | string[] | undefined> {
  const out: Record<string, string | number | string[] | undefined> = {};
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null) continue;
    out[k] = Array.isArray(v) ? v.map(String) : typeof v === "number" ? v : String(v);
  }
  return out;
}

/** Direction of a transfer relative to a set of base keys (chain:address, owner-aware). */
export function transferDirection(t: Transfer, isBase: (a: AddressInfo) => boolean): "in" | "out" | "self" | "none" {
  const f = isBase(t.from) || (t.from.ownerAddress ? isBase(t.from.ownerAddress) : false);
  const to = isBase(t.to) || (t.to.ownerAddress ? isBase(t.to.ownerAddress) : false);
  if (f && to) return "self";
  if (f) return "out";
  if (to) return "in";
  return "none";
}

/** Distinct tokens in a set of transfers, for the token filter (real values from loaded rows). */
export function tokenOptions(rows: Transfer[]): { id: string; label: string }[] {
  const m = new Map<string, string>();
  for (const t of rows) if (!m.has(t.tokenId)) m.set(t.tokenId, t.tokenSymbol ?? (t.tokenId === "native" ? (t.chain === "ethereum" ? "ETH" : "SOL") : t.tokenId.slice(0, 6)));
  return [...m].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
}
