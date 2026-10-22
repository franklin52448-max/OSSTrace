/** Entity ungroup / group. Built only from the user's own entities. */
import type { EntityRef, TraceDoc, TraceEdge, TraceNode, TraceOp, XY } from "@osstrace/contract";
import { effectiveAddress, makeAddressNode, makeEntityNode, type Edit } from "./ops.ts";
import { NODE_WIDTH, nodeCenter, nodeSize } from "./viewport.ts";
import { PLACEMENT_GAP } from "./placement.ts";

export type Refusal = { refused: string };

const touching = (doc: TraceDoc, id: string) => doc.edges.filter((e) => e.fromNodeID === id || e.toNodeID === id);

/** Split an entity node into the addresses its transfer edges actually involve. */
export function ungroupEntityEdit(traceId: string, doc: TraceDoc, entityNode: TraceNode): Edit | Refusal {
  const edges = touching(doc, entityNode.id);
  if (edges.some((e) => e.kind === "aggregate")) return { refused: "Aggregate edges touch this entity. Remove or expand them into transfers first." };
  const transfers = edges.filter((e): e is Extract<TraceEdge, { kind: "transfer" }> => e.kind === "transfer");
  if (transfers.length === 0) return { refused: "This entity has no added transfers to split by address." };
  if (transfers.some((e) => !e.displayTransfer)) return { refused: "Transfer details are still loading." };

  const byAddress = new Map<string, TraceNode>();
  const rewires: { edge: Extract<TraceEdge, { kind: "transfer" }>; newId: string; side: "from" | "to" }[] = [];
  for (const e of transfers) {
    const side = e.fromNodeID === entityNode.id ? "from" : "to";
    const info = effectiveAddress(side === "from" ? e.displayTransfer!.from : e.displayTransfer!.to);
    const key = `${info.chain}:${info.address}`;
    let n = byAddress.get(key) ?? doc.nodes.find((x) => x.kind === "address" && x.chain === info.chain && x.address === info.address);
    if (!n) n = makeAddressNode(traceId, info, { x: 0, y: 0 });
    byAddress.set(key, n);
    const other = side === "from" ? e.toNodeID : e.fromNodeID;
    if (other === n.id) return { refused: "An edge would connect an address to itself." };
    rewires.push({ edge: e, newId: n.id, side });
  }
  // sqrt(n) grid centred on the entity
  const fresh = [...byAddress.values()].filter((n) => !doc.nodes.some((x) => x.id === n.id));
  const cols = Math.ceil(Math.sqrt(fresh.length));
  const rows = Math.ceil(fresh.length / Math.max(1, cols));
  const c = nodeCenter(entityNode);
  const size = nodeSize({});
  const colStep = NODE_WIDTH + PLACEMENT_GAP;
  const placed = fresh.map((n, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const pos: XY = { x: Math.round(c.x - size.w / 2 + (col - (cols - 1) / 2) * colStep), y: Math.round(c.y - size.h / 2 + (row - (rows - 1) / 2) * 200) };
    return { ...n, currentPosition: pos };
  });
  const doOps: TraceOp[] = [
    ...placed.map((node): TraceOp => ({ type: "create_node", node })),
    ...rewires.map((r): TraceOp => ({ type: "update_edge_endpoints", id: r.edge.id, ...(r.side === "from" ? { fromNodeID: r.newId } : { toNodeID: r.newId }) })),
    { type: "delete_node", id: entityNode.id },
  ];
  const undoOps: TraceOp[] = [
    { type: "create_node", node: entityNode },
    ...rewires.map((r): TraceOp => ({ type: "update_edge_endpoints", id: r.edge.id, ...(r.side === "from" ? { fromNodeID: entityNode.id } : { toNodeID: entityNode.id }) })),
    ...placed.map((n): TraceOp => ({ type: "delete_node", id: n.id })),
  ];
  return { label: "Ungroup entity", doOps, undoOps };
}

/** Fold every address node of an entity into one entity node at their centroid. */
export function groupEntityEdit(traceId: string, doc: TraceDoc, entity: EntityRef): Edit | Refusal {
  const members = doc.nodes.filter((n) => n.kind === "address" && n.displayAddress?.entity?.id === entity.id);
  if (members.length === 0) return { refused: "No address of this entity is on the canvas." };
  const ids = new Set(members.map((m) => m.id));
  const edges = doc.edges.filter((e) => ids.has(e.fromNodeID) || ids.has(e.toNodeID));
  if (edges.some((e) => e.kind === "aggregate")) return { refused: "Aggregate edges touch these addresses. Remove them first." };
  if (edges.some((e) => ids.has(e.fromNodeID) && ids.has(e.toNodeID))) return { refused: "Transfers between the entity's own addresses would become a loop." };
  let cx = 0, cy = 0;
  for (const m of members) {
    const c = nodeCenter(m);
    cx += c.x;
    cy += c.y;
  }
  const size = nodeSize({});
  const pos = { x: cx / members.length - size.w / 2, y: cy / members.length - size.h / 2 };
  const existing = doc.nodes.find((n) => n.kind === "entity" && n.entityID === entity.id);
  const ent = existing ?? makeEntityNode(traceId, entity, pos);
  const doOps: TraceOp[] = [
    ...(existing ? [] : [{ type: "create_node", node: ent } as TraceOp]),
    ...edges.map((e): TraceOp => ({ type: "update_edge_endpoints", id: e.id, ...(ids.has(e.fromNodeID) ? { fromNodeID: ent.id } : { toNodeID: ent.id }) })),
    ...members.map((m): TraceOp => ({ type: "delete_node", id: m.id })),
  ];
  const undoOps: TraceOp[] = [
    ...members.map((node): TraceOp => ({ type: "create_node", node })),
    ...edges.map((e): TraceOp => ({ type: "update_edge_endpoints", id: e.id, fromNodeID: e.fromNodeID, toNodeID: e.toNodeID })),
    ...(existing ? [] : [{ type: "delete_node", id: ent.id } as TraceOp]),
  ];
  return { label: "Group addresses", doOps, undoOps };
}
