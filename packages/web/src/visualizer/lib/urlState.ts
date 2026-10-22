/** Scratch-mode URL <-> VisualizerState. `base=ethereum:0xabc,!solana:Abc,entity:<id>`. */
import { CHAINS, DEFAULT_VISUALIZER_STATE, detectChain, normalizeAddress, type Chain, type VisualizerState } from "@osstrace/contract";

export type BaseItem = VisualizerState["base"][number];

const DUR: Record<string, number> = { h: 3600e3, d: 86400e3, w: 7 * 86400e3, M: 30 * 86400e3, y: 365 * 86400e3 };

/** "7d" -> ms. Supports h/d/w/M/y. */
export function parseDurationMs(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([hdwMy])$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1]) * DUR[m[2]!]!;
}

function canonicalAddress(chain: Chain, addr: string) {
  try {
    return normalizeAddress(chain, addr);
  } catch {
    return null;
  }
}

/** One base token -> item. Accepts `chain:address`, `entity:<id>`, or a bare address with a detectable chain. */
export function parseBaseToken(raw: string): BaseItem | null {
  let t = raw.trim();
  if (!t) return null;
  const exclude = t.startsWith("!");
  if (exclude) t = t.slice(1);
  if (t.startsWith("entity:")) {
    const id = t.slice(7);
    return id ? { type: "entity", value: id, exclude } : null;
  }
  const i = t.indexOf(":");
  if (i > 0 && (CHAINS as readonly string[]).includes(t.slice(0, i))) {
    const chain = t.slice(0, i) as Chain;
    const a = canonicalAddress(chain, t.slice(i + 1));
    return a ? { type: "address", value: `${chain}:${a}`, exclude } : null;
  }
  const chain = detectChain(t);
  if (!chain) return null;
  const a = canonicalAddress(chain, t);
  return a ? { type: "address", value: `${chain}:${a}`, exclude } : null;
}

export const baseToken = (b: BaseItem) => `${b.exclude ? "!" : ""}${b.type === "entity" ? `entity:${b.value}` : b.value}`;

const num = (v: string | null): number | null => {
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const list = (v: string | null): string[] | null => {
  if (!v) return null;
  const xs = v.split(",").map((x) => x.trim()).filter(Boolean);
  return xs.length ? xs : null;
};
const time = (v: string | null): number | null => {
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

export function parseScratchParams(sp: URLSearchParams, now = Date.now()): VisualizerState {
  const d = DEFAULT_VISUALIZER_STATE;
  const base = (sp.getAll("base").flatMap((b) => b.split(",")).map(parseBaseToken).filter((b): b is BaseItem => !!b));
  const dedup = new Map(base.map((b) => [`${b.type}:${b.value}`, b]));
  const flow = sp.get("flow");
  const sortKey = sp.get("sortKey");
  const sortDir = sp.get("sortDir");
  const chains = list(sp.get("chains"))?.filter((c): c is Chain => (CHAINS as readonly string[]).includes(c)) ?? null;
  let gte = time(sp.get("timeGte"));
  const last = sp.get("timeLast");
  if (last) {
    const ms = parseDurationMs(last);
    if (ms !== null) gte = now - ms;
  }
  return {
    ...d,
    base: [...dedup.values()],
    filter: {
      ...d.filter,
      flow: flow === "in" || flow === "out" || flow === "self" || flow === "all" ? flow : d.filter.flow,
      sortBy: sortKey === "value" || sortKey === "usd" || sortKey === "time" ? sortKey : d.filter.sortBy,
      sortDir: sortDir === "asc" || sortDir === "desc" ? sortDir : d.filter.sortDir,
      usdGte: sp.has("usdGte") ? num(sp.get("usdGte")) : d.filter.usdGte,
      usdLte: num(sp.get("usdLte")),
      valueGte: num(sp.get("valueGte")),
      valueLte: num(sp.get("valueLte")),
      tokens: list(sp.get("tokens")),
      chains: chains?.length ? chains : null,
      from: list(sp.get("from")),
      to: list(sp.get("to")),
    },
    timeRange: { gte, lte: time(sp.get("timeLte")) },
  };
}

/** Inverse of parseScratchParams for the URL bar (absolute times as epoch ms; defaults omitted). */
export function serializeScratchParams(s: VisualizerState): URLSearchParams {
  const sp = new URLSearchParams();
  const d = DEFAULT_VISUALIZER_STATE.filter;
  if (s.base.length) sp.set("base", s.base.map(baseToken).join(","));
  const f = s.filter;
  if (f.flow !== d.flow) sp.set("flow", f.flow);
  if (f.sortBy !== d.sortBy) sp.set("sortKey", f.sortBy);
  if (f.sortDir !== d.sortDir) sp.set("sortDir", f.sortDir);
  if (f.usdGte !== d.usdGte) sp.set("usdGte", f.usdGte == null ? "" : String(f.usdGte));
  if (f.usdLte != null) sp.set("usdLte", String(f.usdLte));
  if (f.valueGte != null) sp.set("valueGte", String(f.valueGte));
  if (f.valueLte != null) sp.set("valueLte", String(f.valueLte));
  if (f.tokens?.length) sp.set("tokens", f.tokens.join(","));
  if (f.chains?.length) sp.set("chains", f.chains.join(","));
  if (f.from?.length) sp.set("from", f.from.join(","));
  if (f.to?.length) sp.set("to", f.to.join(","));
  if (s.timeRange.gte != null) sp.set("timeGte", String(s.timeRange.gte));
  if (s.timeRange.lte != null) sp.set("timeLte", String(s.timeRange.lte));
  return sp;
}

/** The query for GET /transfers that feeds the canvas: one request, limit 1000. */
export function canvasTransfersQuery(s: VisualizerState, entityAddresses: Map<string, string[]>) {
  const base: string[] = [];
  for (const b of s.base) {
    if (b.exclude) continue;
    if (b.type === "address") base.push(b.value);
    else base.push(...(entityAddresses.get(b.value) ?? []));
  }
  const f = s.filter;
  return {
    base: [...new Set(base)],
    flow: f.flow,
    usdGte: f.usdGte ?? undefined,
    usdLte: f.usdLte ?? undefined,
    valueGte: f.valueGte ?? undefined,
    valueLte: f.valueLte ?? undefined,
    tokens: f.tokens ?? undefined,
    timeGte: s.timeRange.gte != null ? new Date(s.timeRange.gte).toISOString() : undefined,
    timeLte: s.timeRange.lte != null ? new Date(s.timeRange.lte).toISOString() : undefined,
    chain: f.chains?.length === 1 ? f.chains[0] : undefined,
    counterparties: undefined as string[] | undefined,
    sortKey: f.sortBy,
    sortDir: f.sortDir,
    limit: 1000,
  };
}
