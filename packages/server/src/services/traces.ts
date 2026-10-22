import {
  addressNodeId,
  aggregateEdgeId,
  detectChain,
  entityNodeId,
  normalizeAddress,
  transactionNodeId,
  transferEdgeId,
  type AggregateSummary,
  type Chain,
  type EntityRef,
  type Trace,
  type TraceDoc,
  type TraceEdge,
  type TraceNode,
  type TraceOp,
  type TraceSummary,
} from "@osstrace/contract";
import type { Ctx } from "../context.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import { nowIso } from "../lib/time.ts";
import { rowAddresses, rowToTransfer } from "../chain/store.ts";
import { LabelIndex } from "./labelIndex.ts";
import type { AddrKey } from "./transfers.ts";
import type { Param } from "../db/index.ts";

export type TraceRow = { id: string; user_id: string; title: string; notes: string; shareable: number; created_at: string; updated_at: string; version: number };
type NodeRow = {
  id: string;
  kind: TraceNode["kind"];
  chain: Chain | null;
  address: string | null;
  entity_id: string | null;
  tx_hash: string | null;
  x: number;
  y: number;
  pos_ts: string | null;
  width: number | null;
  height: number | null;
  color: TraceNode["color"] | null;
  created_at: string;
};
type EdgeRow = {
  id: string;
  kind: "aggregate" | "transfer";
  from_node: string;
  to_node: string;
  chain: Chain | null;
  transfer_id: string | null;
  agg_usd_in: number | null;
  agg_cnt_in: number | null;
  agg_usd_out: number | null;
  agg_cnt_out: number | null;
  agg_cached_at: string | null;
  created_at: string;
};

export function getTraceRow(ctx: Ctx, id: string): TraceRow | undefined {
  return ctx.db.get<TraceRow>("SELECT * FROM traces WHERE id = ?", id);
}

/** Owner check: other users' traces are indistinguishable from missing ones (404). */
export function ownedTrace(ctx: Ctx, userId: string, id: string): TraceRow {
  const t = getTraceRow(ctx, id);
  if (!t || t.user_id !== userId) throw notFound("Trace not found");
  return t;
}

export function loadDoc(ctx: Ctx, t: TraceRow): TraceDoc {
  const nodes = ctx.db.all<NodeRow>("SELECT * FROM trace_nodes WHERE trace_id = ? ORDER BY ord", t.id);
  const edges = ctx.db.all<EdgeRow>("SELECT * FROM trace_edges WHERE trace_id = ? ORDER BY ord", t.id);
  const posTs: Record<string, string> = {};
  const outNodes = nodes.map((n): TraceNode => {
    if (n.pos_ts) posTs[n.id] = n.pos_ts;
    const node: TraceNode = { id: n.id, kind: n.kind, currentPosition: { x: Number(n.x), y: Number(n.y) }, createdAt: n.created_at };
    if (n.width !== null) node.width = Number(n.width);
    if (n.height !== null) node.height = Number(n.height);
    if (n.color) node.color = n.color;
    if (n.kind === "address" && n.chain && n.address) Object.assign(node, { chain: n.chain, address: n.address });
    if (n.kind === "entity" && n.entity_id) node.entityID = n.entity_id;
    if (n.kind === "transaction" && n.chain && n.tx_hash) Object.assign(node, { transactionChain: n.chain, transactionHash: n.tx_hash });
    return node;
  });
  const outEdges = edges.map((e): TraceEdge =>
    e.kind === "aggregate"
      ? {
          id: e.id,
          kind: "aggregate",
          fromNodeID: e.from_node,
          toNodeID: e.to_node,
          createdAt: e.created_at,
          aggregate: {
            cachedUSDIn: Number(e.agg_usd_in ?? 0),
            cachedTransactionCountIn: Number(e.agg_cnt_in ?? 0),
            cachedUSDOut: Number(e.agg_usd_out ?? 0),
            cachedTransactionCountOut: Number(e.agg_cnt_out ?? 0),
            cachedAt: e.agg_cached_at ?? e.created_at,
          },
        }
      : { id: e.id, kind: "transfer", fromNodeID: e.from_node, toNodeID: e.to_node, createdAt: e.created_at, chain: e.chain!, transferID: e.transfer_id! },
  );
  return { title: t.title, notes: t.notes, shareable: t.shareable === 1, nodes: outNodes, edges: outEdges, posTs };
}

export function saveDoc(ctx: Ctx, t: TraceRow, doc: TraceDoc, updatedAt: string) {
  const { db } = ctx;
  db.run("DELETE FROM trace_edges WHERE trace_id = ?", t.id);
  db.run("DELETE FROM trace_nodes WHERE trace_id = ?", t.id);
  doc.nodes.forEach((n, i) => {
    db.run(
      `INSERT INTO trace_nodes (trace_id, id, ord, kind, chain, address, entity_id, tx_hash, x, y, pos_ts, width, height, color, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      t.id,
      n.id,
      i,
      n.kind,
      n.kind === "address" ? n.chain ?? null : n.kind === "transaction" ? n.transactionChain ?? null : null,
      n.kind === "address" ? n.address ?? null : null,
      n.kind === "entity" ? n.entityID ?? null : null,
      n.kind === "transaction" ? n.transactionHash ?? null : null,
      n.currentPosition.x,
      n.currentPosition.y,
      doc.posTs?.[n.id] ?? null,
      n.width ?? null,
      n.height ?? null,
      n.color ?? null,
      n.createdAt,
    );
  });
  doc.edges.forEach((e, i) => {
    const agg = e.kind === "aggregate" ? e.aggregate : null;
    db.run(
      `INSERT INTO trace_edges (trace_id, id, ord, kind, from_node, to_node, chain, transfer_id, agg_usd_in, agg_cnt_in, agg_usd_out, agg_cnt_out, agg_cached_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      t.id,
      e.id,
      i,
      e.kind,
      e.fromNodeID,
      e.toNodeID,
      e.kind === "transfer" ? e.chain : null,
      e.kind === "transfer" ? e.transferID : null,
      agg?.cachedUSDIn ?? null,
      agg?.cachedTransactionCountIn ?? null,
      agg?.cachedUSDOut ?? null,
      agg?.cachedTransactionCountOut ?? null,
      agg?.cachedAt ?? null,
      e.createdAt,
    );
  });
  db.run("UPDATE traces SET title = ?, notes = ?, shareable = ?, updated_at = ?, version = version + 1 WHERE id = ?", doc.title, doc.notes, doc.shareable ? 1 : 0, updatedAt, t.id);
}

/** Addresses a node stands for: its own address, or every address the owner labelled with that entity. */
export function nodeAddresses(ctx: Ctx, ownerId: string, node: TraceNode | undefined): AddrKey[] {
  if (!node) return [];
  if (node.kind === "address" && node.chain && node.address) return [{ chain: node.chain, address: node.address }];
  if (node.kind === "entity" && node.entityID) return ctx.db.all<AddrKey>("SELECT chain, address FROM labels WHERE user_id = ? AND entity_id = ?", ownerId, node.entityID);
  return [];
}

function sideSql(side: "from" | "to", addrs: AddrKey[], chain: Chain, params: Param[]) {
  const list = addrs.filter((a) => a.chain === chain).map((a) => a.address);
  const ph = list.map(() => "?").join(",");
  params.push(...list, ...list);
  return `(t.${side}_addr IN (${ph}) OR t.${side}_owner IN (${ph}))`;
}

/** In/out are relative to the FROM node: In = to-node -> from-node transfers, Out = from-node -> to-node. From the local cache only. */
export function computeAggregate(ctx: Ctx, a: AddrKey[], b: AddrKey[], cachedAt: string): AggregateSummary {
  const res = { cachedUSDIn: 0, cachedTransactionCountIn: 0, cachedUSDOut: 0, cachedTransactionCountOut: 0, cachedAt };
  const chains = [...new Set(a.map((x) => x.chain))].filter((c) => b.some((y) => y.chain === c));
  for (const chain of chains) {
    for (const dir of ["in", "out"] as const) {
      const params: Param[] = [chain];
      const fromSide = sideSql("from", dir === "in" ? b : a, chain, params);
      const toSide = sideSql("to", dir === "in" ? a : b, chain, params);
      const r = ctx.db.get<{ n: number; usd: number | null }>(`SELECT COUNT(*) AS n, SUM(t.usd) AS usd FROM transfers t WHERE t.chain = ? AND ${fromSide} AND ${toSide}`, ...params)!;
      if (dir === "in") {
        res.cachedTransactionCountIn += Number(r.n);
        res.cachedUSDIn += Number(r.usd ?? 0);
      } else {
        res.cachedTransactionCountOut += Number(r.n);
        res.cachedUSDOut += Number(r.usd ?? 0);
      }
    }
  }
  return res;
}

const CLOCK_SKEW_MS = 5000;

/**
 * Server-side op hygiene before the shared reducer runs: deterministic ids are enforced, client display data
 * and aggregate numbers are dropped (re-derived/recomputed), createdAt is overwritten with commit time and
 * position timestamps from the future are clamped.
 */
export function sanitizeTraceOps(traceId: string, ops: TraceOp[], commitAt: string): TraceOp[] {
  const maxTs = new Date(Date.now() + CLOCK_SKEW_MS).toISOString();
  return ops.map((op): TraceOp => {
    switch (op.type) {
      case "create_node": {
        const n = op.node;
        const base = {
          id: n.id,
          currentPosition: n.currentPosition,
          createdAt: commitAt,
          ...(n.width !== undefined ? { width: n.width } : {}),
          ...(n.height !== undefined ? { height: n.height } : {}),
          ...(n.color !== undefined ? { color: n.color } : {}),
        };
        if (n.kind === "address") {
          if (!n.address) throw badRequest("address node needs an address");
          const chain = n.chain ?? detectChain(n.address);
          if (!chain || detectChain(n.address) !== chain) throw badRequest("address node has an invalid address/chain");
          const address = normalizeAddress(chain, n.address);
          if (n.id !== addressNodeId(traceId, chain, address)) throw badRequest("node id does not match the deterministic id for this address");
          return { type: "create_node", node: { ...base, kind: "address", chain, address } };
        }
        if (n.kind === "entity") {
          if (!n.entityID) throw badRequest("entity node needs entityID");
          if (n.id !== entityNodeId(traceId, n.entityID)) throw badRequest("node id does not match the deterministic id for this entity");
          return { type: "create_node", node: { ...base, kind: "entity", entityID: n.entityID } };
        }
        if (!n.transactionChain || !n.transactionHash) throw badRequest("transaction node needs transactionChain and transactionHash");
        if (n.id !== transactionNodeId(traceId, n.transactionChain, n.transactionHash)) throw badRequest("node id does not match the deterministic id for this transaction");
        return { type: "create_node", node: { ...base, kind: "transaction", transactionChain: n.transactionChain, transactionHash: n.transactionHash } };
      }
      case "create_edge": {
        const e = op.edge;
        if (e.fromNodeID === e.toNodeID) throw badRequest("an edge needs two different nodes");
        if (e.kind === "aggregate") {
          if (e.id !== aggregateEdgeId(traceId, e.fromNodeID, e.toNodeID)) throw badRequest("edge id does not match the deterministic aggregate id");
          return {
            type: "create_edge",
            edge: {
              id: e.id,
              kind: "aggregate",
              fromNodeID: e.fromNodeID,
              toNodeID: e.toNodeID,
              createdAt: commitAt,
              aggregate: { cachedUSDIn: 0, cachedTransactionCountIn: 0, cachedUSDOut: 0, cachedTransactionCountOut: 0, cachedAt: commitAt },
            },
          };
        }
        if (e.id !== transferEdgeId(traceId, e.chain, e.transferID)) throw badRequest("edge id does not match the deterministic transfer id");
        return { type: "create_edge", edge: { id: e.id, kind: "transfer", fromNodeID: e.fromNodeID, toNodeID: e.toNodeID, createdAt: commitAt, chain: e.chain, transferID: e.transferID } };
      }
      case "update_node_position":
        return op.clientTimestamp > maxTs ? { ...op, clientTimestamp: maxTs } : op;
      default:
        return op;
    }
  });
}

/** Recompute every aggregate edge that is new or whose endpoints changed in this batch. */
export function refreshChangedAggregates(ctx: Ctx, ownerId: string, before: TraceDoc, after: TraceDoc, at: string) {
  const prev = new Map(before.edges.map((e) => [e.id, e]));
  const nodes = new Map(after.nodes.map((n) => [n.id, n]));
  after.edges = after.edges.map((e) => {
    if (e.kind !== "aggregate") return e;
    const old = prev.get(e.id);
    if (old && old.fromNodeID === e.fromNodeID && old.toNodeID === e.toNodeID) return e;
    const agg = computeAggregate(ctx, nodeAddresses(ctx, ownerId, nodes.get(e.fromNodeID)), nodeAddresses(ctx, ownerId, nodes.get(e.toNodeID)), at);
    return { ...e, aggregate: agg };
  });
}

/**
 * Full Trace for the API. Authenticated owner reads join the owner's labels/entities/tags at read time.
 * Public (anonymous share) reads join nothing: labels, entities and tags are private to their owner, so every
 * AddressInfo carries only address/chain and entity nodes carry no displayEntity.
 */
export function toTrace(ctx: Ctx, t: TraceRow, doc: TraceDoc, isOwner: boolean, opts: { publicRead?: boolean } = {}): Trace {
  const ownerId = t.user_id;
  const transferKeys = doc.edges.filter((e): e is Extract<TraceEdge, { kind: "transfer" }> => e.kind === "transfer").map((e) => ({ chain: e.chain, id: e.transferID }));
  const rows = ctx.store.getMany(transferKeys);
  const addrs: AddrKey[] = [...rowAddresses([...rows.values()])];
  for (const n of doc.nodes) if (n.kind === "address" && n.chain && n.address) addrs.push({ chain: n.chain, address: n.address });
  const ix = opts.publicRead ? LabelIndex.empty() : LabelIndex.load(ctx.db, ownerId, addrs);
  const entityIds = opts.publicRead ? [] : doc.nodes.filter((n) => n.kind === "entity" && n.entityID).map((n) => n.entityID!);
  const ents = new Map<string, EntityRef>();
  for (const id of entityIds) {
    const e = ctx.db.get<{ id: string; name: string; type: string | null }>("SELECT id, name, type FROM entities WHERE id = ? AND user_id = ?", id, ownerId);
    if (e) ents.set(id, { id: e.id, name: e.name, type: e.type, source: "user" });
  }
  return {
    uuid: t.id,
    title: doc.title,
    notes: doc.notes,
    shareable: doc.shareable,
    isOwner,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    nodes: doc.nodes.map((n) => {
      if (n.kind === "address" && n.chain && n.address) return { ...n, displayAddress: ix.info(n.chain, n.address) };
      if (n.kind === "entity" && n.entityID && ents.has(n.entityID)) return { ...n, displayEntity: ents.get(n.entityID)! };
      return n;
    }),
    edges: doc.edges.map((e) => {
      if (e.kind !== "transfer") return e;
      const r = rows.get(`${e.chain}:${e.transferID}`);
      return r ? { ...e, displayTransfer: rowToTransfer(r, ix) } : e;
    }),
  };
}

export function summaries(ctx: Ctx, userId: string): TraceSummary[] {
  const rows = ctx.db.all<
    TraceRow & { addresses: number; entities: number; transfer_edges: number; agg_count: number | null }
  >(
    `SELECT t.*,
       (SELECT COUNT(*) FROM trace_nodes n WHERE n.trace_id = t.id AND n.kind = 'address') AS addresses,
       (SELECT COUNT(*) FROM trace_nodes n WHERE n.trace_id = t.id AND n.kind = 'entity') AS entities,
       (SELECT COUNT(*) FROM trace_edges e WHERE e.trace_id = t.id AND e.kind = 'transfer') AS transfer_edges,
       (SELECT SUM(COALESCE(e.agg_cnt_in, 0) + COALESCE(e.agg_cnt_out, 0)) FROM trace_edges e WHERE e.trace_id = t.id AND e.kind = 'aggregate') AS agg_count
     FROM traces t WHERE t.user_id = ? ORDER BY t.updated_at DESC`,
    userId,
  );
  return rows.map((r) => ({
    uuid: r.id,
    title: r.title,
    notes: r.notes,
    shareable: r.shareable === 1,
    addressCount: Number(r.addresses),
    entityCount: Number(r.entities),
    transferCount: Number(r.transfer_edges) + Number(r.agg_count ?? 0),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function createTrace(
  ctx: Ctx,
  userId: string,
  opts: { title?: string | undefined; root?: AddrKey | null | undefined; rootEntityId?: string | null | undefined },
  id: string,
): string {
  const now = nowIso();
  ctx.db.tx(() => {
    ctx.db.run("INSERT INTO traces (id, user_id, title, notes, shareable, created_at, updated_at, version) VALUES (?, ?, ?, '', 0, ?, ?, 0)", id, userId, (opts.title ?? "").slice(0, 256), now, now);
    if (opts.root) {
      ctx.db.run(
        "INSERT INTO trace_nodes (trace_id, id, ord, kind, chain, address, x, y, created_at) VALUES (?, ?, 0, 'address', ?, ?, 0, 0, ?)",
        id,
        addressNodeId(id, opts.root.chain, opts.root.address),
        opts.root.chain,
        opts.root.address,
        now,
      );
    }
  });
  return id;
}
