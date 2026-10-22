/** Edge grouping, Bezier geometry and flow-dot parameters. */
import type { TraceEdge, TraceNode, XY } from "@osstrace/contract";
import { nodeCenter, nodeSize, worldToScreen, type Viewport } from "./viewport.ts";

export type BadgeVariant = "aggregate-edge" | "transfer-group";

export type EdgeSummary = {
  totalUSD: number;
  /** true when at least one transfer had no USD price (the total is a lower bound). */
  usdIncomplete: boolean;
  transferCount: number;
  tokens: string[];
  chains: string[];
};

export type Segment = {
  id: string;
  pathID: string;
  fromNodeID: string;
  toNodeID: string;
  variant: BadgeVariant;
  edges: TraceEdge[];
  summary: EdgeSummary;
};

export const pairKey = (a: string, b: string) => (a < b ? `${a}__${b}` : `${b}__${a}`);
export const pathIdFor = (id: string) => `trace-edge-path-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

const tokenKey = (e: Extract<TraceEdge, { kind: "transfer" }>) => {
  const t = e.displayTransfer;
  if (!t) return null;
  return t.tokenId || (t.tokenSymbol ? t.tokenSymbol.toUpperCase() : null);
};

/** Trace overview numbers (also used per segment). */
export function summarize(edges: TraceEdge[]): EdgeSummary {
  let totalUSD = 0;
  let transferCount = 0;
  let usdIncomplete = false;
  const tokenWeight = new Map<string, { label: string; usd: number }>();
  const chains = new Set<string>();
  for (const e of edges) {
    if (e.kind === "aggregate") {
      totalUSD += e.aggregate.cachedUSDIn + e.aggregate.cachedUSDOut;
      transferCount += e.aggregate.cachedTransactionCountIn + e.aggregate.cachedTransactionCountOut;
    } else {
      transferCount += 1;
      chains.add(e.chain);
      const t = e.displayTransfer;
      if (t?.usd != null) totalUSD += t.usd;
      else usdIncomplete = true;
      const k = tokenKey(e);
      if (k) {
        const prev = tokenWeight.get(k) ?? { label: t?.tokenSymbol ?? k, usd: 0 };
        prev.usd += t?.usd ?? 0;
        tokenWeight.set(k, prev);
      }
    }
  }
  const tokens = [...tokenWeight.values()].sort((a, b) => b.usd - a.usd).map((t) => t.label);
  return { totalUSD, usdIncomplete, transferCount, tokens, chains: [...chains] };
}

/** Group edges by unordered node pair. Aggregate edges keep their own direction; transfer groups use the sorted pair. */
export function groupSegments(edges: TraceEdge[]): Segment[] {
  const groups = new Map<string, TraceEdge[]>();
  for (const e of edges) {
    const k = pairKey(e.fromNodeID, e.toNodeID);
    const g = groups.get(k);
    if (g) g.push(e);
    else groups.set(k, [e]);
  }
  const out: Segment[] = [];
  for (const [k, es] of groups) {
    const agg = es.find((e) => e.kind === "aggregate");
    const [a, b] = k.split("__") as [string, string];
    out.push({
      id: k,
      pathID: pathIdFor(k),
      fromNodeID: agg ? agg.fromNodeID : a,
      toNodeID: agg ? agg.toNodeID : b,
      variant: agg ? "aggregate-edge" : "transfer-group",
      edges: es,
      summary: summarize(es),
    });
  }
  return out;
}

export type Box = { w: number; h: number };
export type EdgeGeometry = { d: string; midpoint: XY };

/** Cubic Bezier between node centres, leaving the facing sides (screen space). */
export function edgePath(from: XY, to: XY, fromBox: Box, toBox: Box): EdgeGeometry {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let p0: XY, c1: XY, c2: XY, p3: XY;
  if (Math.abs(dx) <= Math.max(fromBox.w, toBox.w)) {
    const s = dy >= 0 ? 1 : -1;
    const y0 = from.y + (fromBox.h / 2) * s;
    const y1 = to.y - (toBox.h / 2) * s;
    const mid = y0 + (y1 - y0) * 0.5;
    p0 = { x: from.x, y: y0 };
    c1 = { x: from.x, y: mid };
    c2 = { x: to.x, y: mid };
    p3 = { x: to.x, y: y1 };
  } else {
    const s = dx >= 0 ? 1 : -1;
    const x0 = from.x + (fromBox.w / 2) * s;
    const x1 = to.x - (toBox.w / 2) * s;
    const mid = x0 + (x1 - x0) * 0.5;
    p0 = { x: x0, y: from.y };
    c1 = { x: mid, y: from.y };
    c2 = { x: mid, y: to.y };
    p3 = { x: x1, y: to.y };
  }
  const r = (n: number) => Math.round(n * 100) / 100;
  const d = `M${r(p0.x)},${r(p0.y)} C${r(c1.x)},${r(c1.y)} ${r(c2.x)},${r(c2.y)} ${r(p3.x)},${r(p3.y)}`;
  const midpoint = {
    x: 0.125 * p0.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * p3.x,
    y: 0.125 * p0.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * p3.y,
  };
  return { d, midpoint };
}

export function segmentGeometry(seg: Segment, nodes: Map<string, TraceNode>, v: Viewport): EdgeGeometry | null {
  const a = nodes.get(seg.fromNodeID);
  const b = nodes.get(seg.toNodeID);
  if (!a || !b) return null;
  const sa = nodeSize(a);
  const sb = nodeSize(b);
  return edgePath(worldToScreen(nodeCenter(a), v), worldToScreen(nodeCenter(b), v), { w: sa.w * v.scale, h: sa.h * v.scale }, { w: sb.w * v.scale, h: sb.h * v.scale });
}

// ---------- flow dots ----------
const L = (v: number) => Math.log10(Math.max(0, v) + 1);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const dotRadius = (usd: number) => clamp(1.1 + 0.44 * L(usd), 1.1, 2.8);
export const dotOpacity = (usd: number) => clamp(0.7 + 0.09 * L(usd), 0.7, 0.95);
export const dotDuration = (usd: number) => clamp(10.8 - 0.72 * L(usd), 4.7, 10.8);

export type FlowDot = { key: string; r: number; opacity: number; dur: number; begin: number; reverse: boolean };

export function flowDots(seg: Segment): FlowDot[] {
  const agg = seg.edges.find((e) => e.kind === "aggregate");
  if (agg && agg.kind === "aggregate") {
    const a = agg.aggregate;
    const count = a.cachedTransactionCountIn + a.cachedTransactionCountOut;
    const avg = count > 0 ? (a.cachedUSDIn + a.cachedUSDOut) / count : 0;
    const dur = dotDuration(avg);
    const r = 1.45 * dotRadius(avg);
    const opacity = clamp(dotOpacity(avg) - 0.06, 0.7, 0.95);
    const out: FlowDot[] = [];
    // forward = aggregate's from -> to; "out" counts are from the from-node's perspective
    const fwd = Math.min(a.cachedTransactionCountOut, 10);
    const rev = Math.min(a.cachedTransactionCountIn, 10);
    for (let i = 0; i < fwd; i++) out.push({ key: `f${i}`, r, opacity, dur, begin: (i / fwd) * dur, reverse: false });
    for (let i = 0; i < rev; i++) out.push({ key: `r${i}`, r, opacity, dur, begin: (i / rev) * dur, reverse: true });
    return out;
  }
  const transfers = seg.edges.filter((e): e is Extract<TraceEdge, { kind: "transfer" }> => e.kind === "transfer");
  const n = transfers.length;
  return transfers.map((e, i) => {
    const usd = e.displayTransfer?.usd ?? 0;
    const dur = dotDuration(usd);
    return { key: e.id, r: 1.45 * dotRadius(usd), opacity: dotOpacity(usd), dur, begin: (i / n) * dur, reverse: e.fromNodeID !== seg.fromNodeID };
  });
}
