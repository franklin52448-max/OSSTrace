/**
 * Tracer edit builders shared by the web canvas and the server's Tracer agent. They lived in
 * packages/web/src/tracer/lib/ops.ts until the agent needed the exact same "Find connections" logic
 * server-side -- moved here (and re-exported from ops.ts unchanged) rather than re-implemented, so
 * there is one definition of "which pairs get compared" and "how real transfers become edges", not
 * two that can quietly drift apart. Pure functions only: no DOM, no network, ids come only from
 * ids.ts.
 */
import { addressNodeId, normalizeAddress, transferEdgeId } from "./ids.ts";
import type { AddressInfo, TraceEdge, TraceNode, TraceOp, Transfer, XY } from "./types.ts";
import type { TraceDoc } from "./reducers.ts";

/** A composite canvas edit: the ops to apply, and the ops that undo them. */
export type TraceEdit = { label: string; doOps: TraceOp[]; undoOps: TraceOp[] };

const nowIso = () => new Date().toISOString();
const roundXY = (p: XY): XY => ({ x: Math.round(p.x), y: Math.round(p.y) });
const pairOf = (a: string, b: string) => (a < b ? `${a}__${b}` : `${b}__${a}`);

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
  const k = pairOf(a, b);
  return doc.edges.filter((e) => pairOf(e.fromNodeID, e.toNodeID) === k);
};

const recreateEdge = (e: TraceEdge): TraceOp => ({ type: "create_edge", edge: e });
const dropEdge = (e: TraceEdge): TraceOp => ({ type: "delete_edge", id: e.id });

/**
 * Add transfers as transfer edges, creating missing endpoint nodes at the given positions
 * (keyed by node id). Drops the pair's aggregate edge (mutual exclusivity).
 */
export function addTransfersEdit(args: {
  traceId: string;
  doc: TraceDoc;
  transfers: Transfer[];
  positionFor: (info: AddressInfo, index: number) => XY;
}): TraceEdit {
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

/** Every unordered pair of address nodes on the same chain -- "Find connections" only compares
 * same-chain pairs (cross-chain bridge detection is a separate, not-yet-built feature). */
export function pairsToCompare(nodes: readonly TraceNode[]): [TraceNode, TraceNode][] {
  const addr = nodes.filter((n) => n.kind === "address" && n.chain && n.address);
  const pairs: [TraceNode, TraceNode][] = [];
  for (let i = 0; i < addr.length; i++) for (let j = i + 1; j < addr.length; j++) if (addr[i]!.chain === addr[j]!.chain) pairs.push([addr[i]!, addr[j]!]);
  return pairs;
}

/** Keys two nodes' counterparty sets both contain, excluding the nodes themselves -- a lead (both
 * touched the same third party), never proof of a direct relationship between the two nodes. */
export function sharedCounterparties(setA: ReadonlyMap<string, string>, setB: ReadonlyMap<string, string>, selfKeys: ReadonlySet<string>): { key: string; address: string }[] {
  const out: { key: string; address: string }[] = [];
  for (const [key, address] of setA) if (setB.has(key) && !selfKeys.has(key)) out.push({ key, address });
  return out;
}
