/** Builders for composite tracer edits: {doOps, undoOps}. Ids come only from @osstrace/contract helpers. */
import {
  addressNodeId,
  aggregateEdgeId,
  entityNodeId,
  normalizeAddress,
  transferEdgeId,
  type AddressInfo,
  type AggregateSummary,
  type Chain,
  type EntityRef,
  type NodeColor,
  type TraceDoc,
  type TraceEdge,
  type TraceNode,
  type TraceOp,
  type Transfer,
  type XY,
} from "@osstrace/contract";
import { clientTimestamp } from "../../optimistic/index.ts";
import { pairKey } from "./edges.ts";

export type Edit = { label: string; doOps: TraceOp[]; undoOps: TraceOp[] };

const nowIso = () => new Date().toISOString();

/** Solana token accounts collapse onto their owner wallet when the server provides it. */
export const effectiveAddress = (info: AddressInfo): AddressInfo => info.ownerAddress ?? info;

export function makeAddressNode(traceId: string, info: AddressInfo, position: XY): TraceNode {
  const address = normalizeAddress(info.chain, info.address);
  return {
    id: addressNodeId(traceId, info.chain, address),
    kind: "address",
    currentPosition: roundXY(position),
    createdAt: nowIso(),
    address,
    chain: info.chain,
    displayAddress: { ...info, address },
  };
}

export function makeEntityNode(traceId: string, entity: EntityRef, position: XY): TraceNode {
  return { id: entityNodeId(traceId, entity.id), kind: "entity", currentPosition: roundXY(position), createdAt: nowIso(), entityID: entity.id, displayEntity: entity };
}

const roundXY = (p: XY): XY => ({ x: Math.round(p.x), y: Math.round(p.y) });

/** Existing node that already represents this address: its own address node, or a node of its entity. */
export function findNodeForAddress(traceId: string, doc: Pick<TraceDoc, "nodes">, info: AddressInfo): TraceNode | undefined {
  const eff = effectiveAddress(info);
  let id: string;
  try {
    id = addressNodeId(traceId, eff.chain, eff.address);
  } catch {
    return undefined;
  }
  const own = doc.nodes.find((n) => n.id === id);
  if (own) return own;
  const entityId = eff.entity?.id;
  if (entityId) return doc.nodes.find((n) => n.kind === "entity" && n.entityID === entityId);
  return undefined;
}

export const edgesBetween = (doc: Pick<TraceDoc, "edges">, a: string, b: string) => {
  const k = pairKey(a, b);
  return doc.edges.filter((e) => pairKey(e.fromNodeID, e.toNodeID) === k);
};

const recreateEdge = (e: TraceEdge): TraceOp => ({ type: "create_edge", edge: e });
const dropEdge = (e: TraceEdge): TraceOp => ({ type: "delete_edge", id: e.id });

export type DirectionalStats = { usdIn: number; txIn: number; usdOut: number; txOut: number };

/**
 * Add a counterparty of `base` as a node (if missing) plus an aggregate edge seeded with the row's stats.
 * Aggregate and transfer edges are mutually exclusive per pair, so existing pair edges are replaced.
 */
export function addCounterpartyEdit(args: {
  traceId: string;
  doc: TraceDoc;
  base: TraceNode;
  counterparty: AddressInfo | { entity: EntityRef };
  stats: DirectionalStats;
  position: XY;
}): Edit & { nodeId: string } {
  const { traceId, doc, base, stats, position } = args;
  const doOps: TraceOp[] = [];
  const undoOps: TraceOp[] = [];
  let target: TraceNode | undefined;
  let createdNode: TraceNode | null = null;
  if ("address" in args.counterparty) {
    target = findNodeForAddress(traceId, doc, args.counterparty);
    if (!target) createdNode = makeAddressNode(traceId, effectiveAddress(args.counterparty), position);
  } else {
    const id = entityNodeId(traceId, args.counterparty.entity.id);
    target = doc.nodes.find((n) => n.id === id);
    if (!target) createdNode = makeEntityNode(traceId, args.counterparty.entity, position);
  }
  const nodeId = (target ?? createdNode)!.id;
  if (createdNode) doOps.push({ type: "create_node", node: createdNode });
  const existing = target ? edgesBetween(doc, base.id, target.id) : [];
  doOps.push(...existing.map(dropEdge));
  const aggregate: AggregateSummary = {
    cachedUSDIn: stats.usdIn,
    cachedTransactionCountIn: stats.txIn,
    cachedUSDOut: stats.usdOut,
    cachedTransactionCountOut: stats.txOut,
    cachedAt: nowIso(),
  };
  const edge: TraceEdge = { id: aggregateEdgeId(traceId, base.id, nodeId), kind: "aggregate", fromNodeID: base.id, toNodeID: nodeId, createdAt: nowIso(), aggregate };
  doOps.push({ type: "create_edge", edge });
  undoOps.push({ type: "delete_edge", id: edge.id });
  undoOps.push(...existing.map(recreateEdge));
  if (createdNode) undoOps.push({ type: "delete_node", id: createdNode.id });
  return { label: createdNode ? "Add node and relationship" : "Add relationship", doOps, undoOps, nodeId };
}

/**
 * Add transfers as transfer edges, creating missing endpoint nodes at the given positions
 * (keyed by node id). Drops the pair's aggregate edge (mutual exclusivity).
 */
export function addTransfersEdit(args: {
  traceId: string;
  doc: TraceDoc;
  transfers: Transfer[];
  positionFor: (info: AddressInfo, index: number) => XY;
}): Edit {
  const { traceId, doc, transfers, positionFor } = args;
  const nodes = new Map(doc.nodes.map((n) => [n.id, n]));
  const created: TraceNode[] = [];
  const createdEdges: TraceEdge[] = [];
  const removedAggs = new Map<string, TraceEdge>();
  const resolve = (info: AddressInfo, i: number): string => {
    const found = findNodeForAddress(traceId, { nodes: [...nodes.values()] }, info);
    if (found) return found.id;
    const n = makeAddressNode(traceId, effectiveAddress(info), positionFor(info, i));
    nodes.set(n.id, n);
    created.push(n);
    return n.id;
  };
  transfers.forEach((t, i) => {
    const id = transferEdgeId(traceId, t.chain, t.id);
    if (doc.edges.some((e) => e.id === id) || createdEdges.some((e) => e.id === id)) return;
    const from = resolve(t.from, i);
    const to = resolve(t.to, i);
    if (from === to) return; // self transfer collapses onto one node: nothing to draw
    for (const e of edgesBetween(doc, from, to)) if (e.kind === "aggregate") removedAggs.set(e.id, e);
    createdEdges.push({ id, kind: "transfer", fromNodeID: from, toNodeID: to, createdAt: nowIso(), chain: t.chain, transferID: t.id, displayTransfer: t });
  });
  const doOps: TraceOp[] = [
    ...created.map((node): TraceOp => ({ type: "create_node", node })),
    ...[...removedAggs.values()].map(dropEdge),
    ...createdEdges.map(recreateEdge),
  ];
  const undoOps: TraceOp[] = [
    ...createdEdges.map(dropEdge),
    ...[...removedAggs.values()].map(recreateEdge),
    ...created.map((n): TraceOp => ({ type: "delete_node", id: n.id })),
  ];
  const n = createdEdges.length;
  return { label: n === 1 ? (created.length ? "Add node and transfer" : "Add transfer") : `Add ${n} transfers`, doOps, undoOps };
}

/** Replace every edge between a pair with one aggregate edge. */
export function aggregatePairEdit(traceId: string, doc: TraceDoc, fromId: string, toId: string, summary: AggregateSummary): Edit | null {
  if (summary.cachedTransactionCountIn + summary.cachedTransactionCountOut === 0) return null;
  const existing = edgesBetween(doc, fromId, toId);
  const edge: TraceEdge = { id: aggregateEdgeId(traceId, fromId, toId), kind: "aggregate", fromNodeID: fromId, toNodeID: toId, createdAt: nowIso(), aggregate: summary };
  return {
    label: "Aggregate transfers",
    doOps: [...existing.map(dropEdge), recreateEdge(edge)],
    undoOps: [dropEdge(edge), ...existing.map(recreateEdge)],
  };
}

/** Summary from the pair's transfer edges, used when the server summary is not available. */
export function summaryFromTransferEdges(doc: TraceDoc, fromId: string, toId: string): AggregateSummary {
  const s: AggregateSummary = { cachedUSDIn: 0, cachedTransactionCountIn: 0, cachedUSDOut: 0, cachedTransactionCountOut: 0, cachedAt: nowIso() };
  for (const e of edgesBetween(doc, fromId, toId)) {
    if (e.kind !== "transfer") continue;
    const usd = e.displayTransfer?.usd ?? 0;
    if (e.fromNodeID === fromId) {
      s.cachedUSDOut += usd;
      s.cachedTransactionCountOut += 1;
    } else {
      s.cachedUSDIn += usd;
      s.cachedTransactionCountIn += 1;
    }
  }
  return s;
}

/**
 * Delete nodes and/or edges, then cascade: nodes left isolated by the removal are removed too (BFS outward).
 * The oldest node (min createdAt, ignoring nodes still pending creation) is never auto-removed.
 */
export function removeEdit(doc: TraceDoc, nodeIds: string[], edgeIds: string[] = [], pendingNodeIds: Set<string> = new Set()): Edit & { removedNodeIds: string[] } {
  const removedNodes = new Set(nodeIds.filter((id) => doc.nodes.some((n) => n.id === id)));
  const removedEdges = new Set<string>();
  const settled = doc.nodes.filter((n) => !pendingNodeIds.has(n.id));
  const oldest = settled.reduce<TraceNode | null>((m, n) => (!m || n.createdAt < m.createdAt ? n : m), null);

  const markEdgesOf = (id: string) => {
    for (const e of doc.edges) if (e.fromNodeID === id || e.toNodeID === id) removedEdges.add(e.id);
  };
  for (const id of removedNodes) markEdgesOf(id);
  for (const id of edgeIds) if (doc.edges.some((e) => e.id === id)) removedEdges.add(id);

  // BFS over neighbours that became isolated
  let frontier = doc.edges.filter((e) => removedEdges.has(e.id)).flatMap((e) => [e.fromNodeID, e.toNodeID]);
  while (frontier.length) {
    const next: string[] = [];
    for (const id of new Set(frontier)) {
      if (removedNodes.has(id) || id === oldest?.id) continue;
      const alive = doc.edges.some((e) => !removedEdges.has(e.id) && (e.fromNodeID === id || e.toNodeID === id));
      if (alive) continue;
      removedNodes.add(id);
      for (const e of doc.edges) if (e.fromNodeID === id || e.toNodeID === id) {
        if (!removedEdges.has(e.id)) {
          removedEdges.add(e.id);
          next.push(e.fromNodeID, e.toNodeID);
        }
      }
    }
    frontier = next;
  }

  const nodes = doc.nodes.filter((n) => removedNodes.has(n.id));
  const edges = doc.edges.filter((e) => removedEdges.has(e.id));
  // edges touching a deleted node go away with it; delete only the "free" edges explicitly
  const freeEdges = edges.filter((e) => !removedNodes.has(e.fromNodeID) && !removedNodes.has(e.toNodeID));
  const doOps: TraceOp[] = [...freeEdges.map(dropEdge), ...nodes.map((n): TraceOp => ({ type: "delete_node", id: n.id }))];
  const undoOps: TraceOp[] = [...nodes.map((node): TraceOp => ({ type: "create_node", node })), ...edges.map(recreateEdge)];
  const label = nodes.length === 0 ? (edges.length === 1 ? "Remove edge" : `Remove ${edges.length} edges`) : nodes.length === 1 ? "Remove node" : `Remove ${nodes.length} nodes`;
  return { label, doOps, undoOps, removedNodeIds: nodes.map((n) => n.id) };
}

export function moveOps(positions: Map<string, XY>): TraceOp[] {
  const ts = clientTimestamp();
  return [...positions].map(([id, p]) => ({ type: "update_node_position", id, position: roundXY(p), clientTimestamp: ts }));
}

export function colorEdit(nodes: TraceNode[], color: NodeColor | null): Edit {
  return {
    label: "Change node color",
    doOps: nodes.map((n) => ({ type: "set_node_color", id: n.id, color })),
    undoOps: nodes.map((n) => ({ type: "set_node_color", id: n.id, color: n.color ?? null })),
  };
}

export function sizeEdit(node: TraceNode, width: number | null, height: number | null): Edit {
  return {
    label: width === null ? "Reset size" : "Resize node",
    doOps: [{ type: "update_node_size", id: node.id, width, height }],
    undoOps: [{ type: "update_node_size", id: node.id, width: node.width ?? null, height: node.height ?? null }],
  };
}

/** Is this transfer edge already on the canvas? (deterministic id) */
export const hasTransfer = (traceId: string, doc: Pick<TraceDoc, "edges">, chain: Chain, transferId: string) =>
  doc.edges.some((e) => e.id === transferEdgeId(traceId, chain, transferId));
