import type {
  Trace,
  TraceEdge,
  TraceNode,
  TraceOp,
  VisualizerOp,
  VisualizerState,
  XY,
} from "./types.ts";

/** Trace document as the reducer sees it. `posTs` is server-internal last-writer-wins bookkeeping. */
export type TraceDoc = Pick<Trace, "title" | "notes" | "shareable" | "nodes" | "edges"> & {
  posTs?: Record<string, string>;
};

export type ApplyResult<D> = { doc: D; applied: number; skipped: number };

const removeById = <T extends { id: string }>(xs: T[], id: string) => xs.filter((x) => x.id !== id);

/**
 * Pure, idempotent op reducer. Used by the server (authoritative) and by the web client (optimistic replay).
 * - create_* : append only if the id is absent (so retries / replays are no-ops)
 * - delete_node : removes the node AND every edge touching it
 * - update_node_position : last-writer-wins on clientTimestamp (string compare of same-format ISO strings)
 * - ops that reference a missing id are skipped, never errors
 */
export function applyTraceOps(input: TraceDoc, ops: TraceOp[]): ApplyResult<TraceDoc> {
  let { title, notes, shareable } = input;
  let nodes = input.nodes;
  let edges = input.edges;
  const posTs = { ...(input.posTs ?? {}) };
  let applied = 0;
  let skipped = 0;
  const ok = () => void applied++;
  const skip = () => void skipped++;
  const hasNode = (id: string) => nodes.some((n) => n.id === id);

  for (const op of ops) {
    switch (op.type) {
      case "create_node":
        if (hasNode(op.node.id)) skip();
        else {
          nodes = [...nodes, op.node];
          ok();
        }
        break;
      case "create_edge":
        if (edges.some((e) => e.id === op.edge.id)) skip();
        else if (!hasNode(op.edge.fromNodeID) || !hasNode(op.edge.toNodeID)) skip();
        else {
          edges = [...edges, op.edge];
          ok();
        }
        break;
      case "delete_node":
        if (!hasNode(op.id)) skip();
        else {
          nodes = removeById(nodes, op.id);
          edges = edges.filter((e) => e.fromNodeID !== op.id && e.toNodeID !== op.id);
          delete posTs[op.id];
          ok();
        }
        break;
      case "delete_edge":
        if (!edges.some((e) => e.id === op.id)) skip();
        else {
          edges = removeById(edges, op.id);
          ok();
        }
        break;
      case "update_edge_endpoints": {
        const edge = edges.find((e) => e.id === op.id);
        const from = op.fromNodeID ?? edge?.fromNodeID;
        const to = op.toNodeID ?? edge?.toNodeID;
        if (!edge || !from || !to || !hasNode(from) || !hasNode(to)) skip();
        else {
          edges = edges.map((e): TraceEdge => (e.id === op.id ? ({ ...e, fromNodeID: from, toNodeID: to } as TraceEdge) : e));
          ok();
        }
        break;
      }
      case "update_node_position": {
        const prev = posTs[op.id];
        if (!hasNode(op.id) || (prev !== undefined && op.clientTimestamp < prev)) skip();
        else {
          posTs[op.id] = op.clientTimestamp;
          nodes = nodes.map((n): TraceNode => (n.id === op.id ? { ...n, currentPosition: op.position } : n));
          ok();
        }
        break;
      }
      case "update_node_size":
        if (!hasNode(op.id)) skip();
        else {
          nodes = nodes.map((n): TraceNode => (n.id === op.id ? { ...n, width: op.width, height: op.height } : n));
          ok();
        }
        break;
      case "set_node_color":
        if (!hasNode(op.id)) skip();
        else {
          nodes = nodes.map((n): TraceNode => (n.id === op.id ? { ...n, color: op.color } : n));
          ok();
        }
        break;
      case "set_title":
        title = op.title.slice(0, 256);
        ok();
        break;
      case "set_notes":
        notes = op.notes;
        ok();
        break;
      case "set_shareable":
        shareable = op.shareable;
        ok();
        break;
      default:
        skip();
    }
  }
  return { doc: { title, notes, shareable, nodes, edges, posTs }, applied, skipped };
}

/** Visualizer document as the reducer sees it. `fieldTs` is server-internal per-field last-writer-wins. */
export type VisualizerDoc = { name: string; shareable: boolean; state: VisualizerState; fieldTs?: Record<string, string> };

/** Per-field last-writer-wins on clientTimestamp; positions are keyed per node. */
export function applyVisualizerOps(input: VisualizerDoc, ops: VisualizerOp[]): ApplyResult<VisualizerDoc> {
  let { name, shareable, state } = input;
  const fieldTs = { ...(input.fieldTs ?? {}) };
  let applied = 0;
  let skipped = 0;
  const stale = (key: string, ts: string) => {
    const prev = fieldTs[key];
    if (prev !== undefined && ts < prev) return true;
    fieldTs[key] = ts;
    return false;
  };
  for (const op of ops) {
    const ts = op.clientTimestamp;
    switch (op.type) {
      case "set_filter":
        if (stale("filter", ts)) skipped++;
        else (state = { ...state, filter: op.filter }), applied++;
        break;
      case "set_time_range":
        if (stale("timeRange", ts)) skipped++;
        else (state = { ...state, timeRange: op.timeRange }), applied++;
        break;
      case "set_base":
        if (stale("base", ts)) skipped++;
        else (state = { ...state, base: op.base }), applied++;
        break;
      case "set_is_hidden_for_type":
        if (stale(`isHidden:${op.typeKey}`, ts)) skipped++;
        else (state = { ...state, isHidden: { ...state.isHidden, [op.typeKey]: op.isHiddenValue } }), applied++;
        break;
      case "add_expanded":
        if (stale(`expanded:${op.nodeID}`, ts) || state.expanded.includes(op.nodeID)) skipped++;
        else (state = { ...state, expanded: [...state.expanded, op.nodeID] }), applied++;
        break;
      case "remove_expanded":
        if (stale(`expanded:${op.nodeID}`, ts) || !state.expanded.includes(op.nodeID)) skipped++;
        else (state = { ...state, expanded: state.expanded.filter((x) => x !== op.nodeID) }), applied++;
        break;
      case "set_position":
        if (stale(`pos:${op.nodeID}`, ts)) skipped++;
        else (state = { ...state, positions: { ...state.positions, [op.nodeID]: roundXY(op.position) } }), applied++;
        break;
      case "delete_position": {
        if (stale(`pos:${op.nodeID}`, ts) || !(op.nodeID in state.positions)) {
          skipped++;
          break;
        }
        const { [op.nodeID]: _gone, ...rest } = state.positions;
        state = { ...state, positions: rest };
        applied++;
        break;
      }
      case "set_name":
        if (stale("name", ts)) skipped++;
        else (name = op.name.slice(0, 256)), applied++;
        break;
      case "set_shareable":
        if (stale("shareable", ts)) skipped++;
        else (shareable = op.shareable), applied++;
        break;
      default:
        skipped++;
    }
  }
  return { doc: { name, shareable, state, fieldTs }, applied, skipped };
}

const roundXY = (p: XY): XY => ({ x: Math.round(p.x), y: Math.round(p.y) });
