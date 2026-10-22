/** Transfers -> force-graph nodes/links and the Send-to-Tracer seed. */
import {
  addressNodeId,
  aggregateEdgeId,
  entityNodeId,
  type AddressInfo,
  type Chain,
  type EntityRef,
  type TraceEdge,
  type TraceNode,
  type TraceOp,
  type Transfer,
  type VisualizerState,
  type XY,
} from "@osstrace/contract";
import { shortAddress } from "../../kit/format.ts";

export type TypeGroup = "cex" | "deposit" | "individual" | "dex" | "lending" | "misc" | "uncategorized";

export const TYPE_GROUPS: { key: TypeGroup; label: string; color: string | null }[] = [
  { key: "cex", label: "Exchanges", color: "--trace-node-red" },
  { key: "deposit", label: "Deposit addresses", color: "--trace-node-amber" },
  { key: "individual", label: "Individuals and funds", color: "--trace-node-purple" },
  { key: "dex", label: "Decentralized exchanges", color: "--trace-node-green" },
  { key: "lending", label: "Lending", color: "--trace-node-blue" },
  { key: "misc", label: "Other entity types", color: "--trace-node-gray" },
  { key: "uncategorized", label: "Unlabelled", color: null },
];

/** User entity `type` is free text: map it onto a legend group. */
export function typeGroup(type: string | null | undefined, hasEntity: boolean): TypeGroup {
  if (!hasEntity) return "uncategorized";
  const t = (type ?? "").toLowerCase();
  if (!t) return "misc";
  if (/(^|\b)(cex|exchange)/.test(t)) return "cex";
  if (/deposit/.test(t)) return "deposit";
  if (/(individual|person|fund|whale|vc)/.test(t)) return "individual";
  if (/(dex|swap|aggregator|amm|derivative|option)/.test(t)) return "dex";
  if (/(lend|borrow|cdp)/.test(t)) return "lending";
  return "misc";
}

export type GraphNode = {
  id: string;
  kind: "address" | "entity";
  label: string;
  chain?: Chain;
  address?: string;
  info?: AddressInfo;
  entity?: EntityRef;
  addresses: Set<string>;
  group: TypeGroup;
  isBase: boolean;
  isPinned: boolean;
  inflow: number;
  outflow: number;
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
  vx?: number;
  vy?: number;
  /** transient freeze (not persisted) while a re-query rebuilds the graph */
  frozen?: boolean;
};

export type GraphLink = { id: string; source: string | GraphNode; target: string | GraphNode; tx: Transfer; usd: number | null; curvature: number };

export const addressKey = (a: AddressInfo) => `${a.chain}:${a.address}`;
export const entityKey = (id: string) => `entity:${id}`;
/** Solana token accounts collapse onto their owner wallet (server provides ownerAddress). */
export const collapse = (a: AddressInfo): AddressInfo => a.ownerAddress ?? a;

/** Node id for an address: its entity (aggregated) unless that entity is expanded. */
export function nodeIdFor(a: AddressInfo, expanded: Set<string>): string {
  const ent = a.entity;
  if (ent && !expanded.has(ent.id)) return entityKey(ent.id);
  return addressKey(a);
}

export function isBaseNode(n: Pick<GraphNode, "id" | "kind" | "entity" | "info">, includedBase: Set<string>): boolean {
  if (n.kind === "entity") return !!n.entity && includedBase.has(n.entity.id);
  if (includedBase.has(n.id)) return true;
  return !!n.info?.entity && includedBase.has(n.info.entity.id);
}

export const curvatureFor = (i: number, n: number) => (n <= 1 ? 0 : (i / (n - 1) - 0.5) / 3.5);

/** Width 0.25..2.0 in steps of 0.125 by log USD; links without a price get 0.5. */
export function linkWidth(usd: number | null): number {
  if (usd == null) return 0.5;
  const v = Math.log(1 + Math.min(Math.max(usd, 0), 1e8) / 1e4) / Math.log(10001);
  return Math.round(8 * (v * 1.75 + 0.25)) / 8;
}

export type BuildArgs = { transfers: Transfer[]; state: VisualizerState; reuse?: Map<string, GraphNode> };
export type BuildResult = { nodes: GraphNode[]; links: GraphLink[]; excludedLinks: number };

/**
 * One link per transfer; multiple links per unordered pair fan out by curvature. Node objects are reused across
 * rebuilds (force-graph keeps x/y/vx/vy on them), so re-queries do not scramble the layout.
 */
export function buildGraph({ transfers, state, reuse }: BuildArgs): BuildResult {
  const expanded = new Set(state.expanded);
  const included = new Set(state.base.filter((b) => !b.exclude).map((b) => b.value));
  const excluded = new Set(state.base.filter((b) => b.exclude).map((b) => (b.type === "entity" ? entityKey(b.value) : b.value)));
  const fromF = state.filter.from ? new Set(state.filter.from) : null;
  const toF = state.filter.to ? new Set(state.filter.to) : null;
  const chainF = state.filter.chains ? new Set(state.filter.chains) : null;
  const nodes = new Map<string, GraphNode>();
  const touch = (a: AddressInfo): GraphNode => {
    const id = nodeIdFor(a, expanded);
    let n = nodes.get(id);
    if (!n) {
      const prev = reuse?.get(id);
      const isEnt = id.startsWith("entity:");
      const ent = a.entity ?? undefined;
      n = Object.assign(prev ?? ({} as GraphNode), {
        id,
        kind: isEnt ? "entity" : "address",
        label: isEnt ? ent!.name : a.label?.name ?? ent?.name ?? shortAddress(a.address, 4, 4),
        chain: isEnt ? undefined : a.chain,
        address: isEnt ? undefined : a.address,
        info: isEnt ? undefined : a,
        entity: ent,
        addresses: new Set<string>(),
        group: typeGroup(ent?.type, !!ent),
        isBase: false,
        isPinned: false,
        inflow: 0,
        outflow: 0,
      } satisfies Partial<GraphNode>) as GraphNode;
      n.isBase = isBaseNode(n, included);
      const pin = state.positions[id];
      if (pin) {
        n.isPinned = true;
        n.fx = pin.x;
        n.fy = pin.y;
        if (n.x === undefined) {
          n.x = pin.x;
          n.y = pin.y;
        }
      } else if (!n.frozen) {
        n.fx = undefined;
        n.fy = undefined;
      }
      nodes.set(id, n);
    }
    n.addresses.add(addressKey(a));
    return n;
  };

  const pairs = new Map<string, GraphLink[]>();
  const links: GraphLink[] = [];
  let excludedLinks = 0;
  for (const t of transfers) {
    if (!t?.from?.address || !t?.to?.address) continue;
    if (chainF && !chainF.has(t.chain)) continue;
    const from = collapse(t.from);
    const to = collapse(t.to);
    if (fromF && !fromF.has(addressKey(from)) && !fromF.has(from.address)) continue;
    if (toF && !toF.has(addressKey(to)) && !toF.has(to.address)) continue;
    const a = nodeIdFor(from, expanded);
    const b = nodeIdFor(to, expanded);
    if (a === b) continue; // self-loop after collapsing: nothing to draw
    if (excluded.has(a) || excluded.has(b)) {
      excludedLinks++;
      continue;
    }
    const s = touch(from);
    const d = touch(to);
    const usd = t.usd;
    s.outflow += 1;
    d.inflow += 1;
    const link: GraphLink = { id: `${t.chain}:${t.id}`, source: s.id, target: d.id, tx: t, usd, curvature: 0 };
    const k = s.id < d.id ? `${s.id}|${d.id}` : `${d.id}|${s.id}`;
    const g = pairs.get(k);
    if (g) g.push(link);
    else pairs.set(k, [link]);
    links.push(link);
  }
  for (const g of pairs.values()) g.forEach((l, i) => (l.curvature = curvatureFor(i, g.length)));
  // address bases with no matching transfers still appear, so the canvas shows what was asked for
  for (const b of state.base) {
    if (b.exclude || b.type !== "address" || nodes.has(b.value) || [...nodes.values()].some((n) => n.addresses.has(b.value))) continue;
    const i = b.value.indexOf(":");
    touch({ chain: b.value.slice(0, i) as Chain, address: b.value.slice(i + 1) });
  }
  return { nodes: [...nodes.values()], links, excludedLinks };
}

export type LinkSide = "in" | "out" | "neutral";
/** green when the target is base (incoming), out-ink when the source is base, neutral otherwise. */
export function linkSide(src: GraphNode, dst: GraphNode): LinkSide {
  if (src.isBase === dst.isBase) return "neutral";
  return dst.isBase ? "in" : "out";
}

/** Stats over visible links for the overview. */
export function visibleStats(links: GraphLink[]) {
  let volume = 0;
  let unpriced = 0;
  const tokens = new Set<string>();
  const chains = new Set<string>();
  for (const l of links) {
    if (l.usd != null) volume += l.usd;
    else unpriced++;
    tokens.add(`${l.tx.chain}:${l.tx.tokenId}`);
    chains.add(l.tx.chain);
  }
  return { transferCount: links.length, volumeUSD: volume, unpriced, tokenCount: tokens.size, chainCount: chains.size };
}

// ---------- Send to Tracer ----------
export type Neighbour = { node: GraphNode; usdIn: number; usdOut: number; countIn: number; countOut: number; offset: XY | null };

const endId = (e: string | GraphNode) => (typeof e === "string" ? e : e.id);

/** Per-neighbour sums over visible links touching `origin`, sorted by total USD then count. */
export function extractNeighbourhood(origin: GraphNode, links: GraphLink[], byId: Map<string, GraphNode>): Neighbour[] {
  const m = new Map<string, Neighbour>();
  for (const l of links) {
    const s = endId(l.source);
    const t = endId(l.target);
    if (s !== origin.id && t !== origin.id) continue;
    const otherId = s === origin.id ? t : s;
    const other = byId.get(otherId);
    if (!other) continue;
    let nb = m.get(otherId);
    if (!nb) {
      const off = other.x != null && origin.x != null ? { x: other.x - origin.x, y: (other.y ?? 0) - (origin.y ?? 0) } : null;
      nb = { node: other, usdIn: 0, usdOut: 0, countIn: 0, countOut: 0, offset: off };
      m.set(otherId, nb);
    }
    if (s === origin.id) {
      nb.usdOut += l.usd ?? 0;
      nb.countOut += 1;
    } else {
      nb.usdIn += l.usd ?? 0;
      nb.countIn += 1;
    }
  }
  return [...m.values()].sort((a, b) => b.usdIn + b.usdOut - (a.usdIn + a.usdOut) || b.countIn + b.countOut - (a.countIn + a.countOut));
}

const SEED_MEDIAN = 560;
const BOX_W = 254 + 60;
const BOX_H = 72 + 48;

/** Scale canvas offsets so the median distance is 560 (each clamped 420..1600), then push out of overlaps. */
export function seedLayout(offsets: (XY | null)[]): XY[] {
  const dists = offsets.map((o) => (o ? Math.hypot(o.x, o.y) : 0)).filter((d) => d > 0).sort((a, b) => a - b);
  const median = dists.length ? dists[Math.floor(dists.length / 2)]! : 0;
  const k = median > 0 ? SEED_MEDIAN / median : 1;
  const noOffset = offsets.filter((o) => !o || (o.x === 0 && o.y === 0)).length;
  let ring = 0;
  const placed: XY[] = [{ x: 0, y: 0 }];
  const out: XY[] = [];
  for (const o of offsets) {
    let p: XY;
    if (!o || (o.x === 0 && o.y === 0)) {
      const a = (2 * Math.PI * ring++) / Math.max(1, noOffset);
      p = { x: Math.cos(a) * SEED_MEDIAN, y: Math.sin(a) * SEED_MEDIAN };
    } else {
      const d = Math.hypot(o.x, o.y);
      const nd = Math.min(1600, Math.max(420, d * k));
      p = { x: (o.x / d) * nd, y: (o.y / d) * nd };
    }
    const len = Math.hypot(p.x, p.y) || 1;
    for (let i = 0; i < 40 && placed.some((q) => Math.abs(q.x - p.x) < BOX_W && Math.abs(q.y - p.y) < BOX_H); i++) {
      p = { x: p.x + (p.x / len) * 90, y: p.y + (p.y / len) * 90 };
    }
    p = { x: Math.round(p.x), y: Math.round(p.y) };
    placed.push(p);
    out.push(p);
  }
  return out;
}

function traceNodeFor(traceId: string, g: GraphNode, pos: XY, now: string): TraceNode {
  if (g.kind === "entity" && g.entity) return { id: entityNodeId(traceId, g.entity.id), kind: "entity", currentPosition: pos, createdAt: now, entityID: g.entity.id, displayEntity: g.entity };
  return { id: addressNodeId(traceId, g.chain!, g.address!), kind: "address", currentPosition: pos, createdAt: now, address: g.address, chain: g.chain, displayAddress: g.info };
}

/** set_title, origin node at 0,0, then node + aggregate edge per picked neighbour. */
export function buildTraceSeedOps(traceId: string, origin: GraphNode, picked: Neighbour[], now = new Date().toISOString()): TraceOp[] {
  const o = traceNodeFor(traceId, origin, { x: 0, y: 0 }, now);
  const ops: TraceOp[] = [{ type: "set_title", title: origin.label }, { type: "create_node", node: o }];
  const pos = seedLayout(picked.map((p) => p.offset));
  picked.forEach((nb, i) => {
    const n = traceNodeFor(traceId, nb.node, pos[i]!, now);
    const edge: TraceEdge = {
      id: aggregateEdgeId(traceId, o.id, n.id),
      kind: "aggregate",
      fromNodeID: o.id,
      toNodeID: n.id,
      createdAt: now,
      aggregate: { cachedUSDIn: nb.usdIn, cachedTransactionCountIn: nb.countIn, cachedUSDOut: nb.usdOut, cachedTransactionCountOut: nb.countOut, cachedAt: now },
    };
    ops.push({ type: "create_node", node: n }, { type: "create_edge", edge });
  });
  return ops;
}
