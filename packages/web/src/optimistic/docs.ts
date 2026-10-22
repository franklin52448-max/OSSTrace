/** Tracer / visualizer adapters for the optimistic engine: replay stamping and undo sanitizers. */
import type { TraceOp, VisualizerOp } from "@osstrace/contract";
import type { Transaction } from "./store.ts";

/** Same-format ISO clock that never goes backwards within this tab (positions are last-writer-wins). */
let lastStamp = 0;
export function clientTimestamp(): string {
  const now = Math.max(Date.now(), lastStamp + 1);
  lastStamp = now;
  return new Date(now).toISOString();
}

/** Undo/redo of a move must win over the original move: stamp a fresh clientTimestamp. */
export function prepareTraceReplay(ops: TraceOp[]): TraceOp[] {
  return ops.map((op) => (op.type === "update_node_position" ? { ...op, clientTimestamp: clientTimestamp() } : op));
}

export function prepareVisualizerReplay(ops: VisualizerOp[]): VisualizerOp[] {
  return ops.map((op) => ({ ...op, clientTimestamp: clientTimestamp() }));
}

/**
 * If this edit deletes a node/edge whose create_* is still in flight, drop that create_* from the undo ops,
 * so undo cannot resurrect something the server may never have accepted.
 */
export function sanitizeTraceUndo(undoOps: TraceOp[], doOps: TraceOp[], inFlight: Transaction<TraceOp>[]): TraceOp[] {
  const pending = new Set<string>();
  for (const t of inFlight)
    for (const op of t.doOps) {
      if (op.type === "create_node") pending.add(op.node.id);
      else if (op.type === "create_edge") pending.add(op.edge.id);
    }
  if (pending.size === 0) return undoOps;
  const deleted = new Set<string>();
  for (const op of doOps) if (op.type === "delete_node" || op.type === "delete_edge") deleted.add(op.id);
  const drop = (id: string) => pending.has(id) && deleted.has(id);
  return undoOps.filter((op) => {
    if (op.type === "create_node") return !drop(op.node.id);
    if (op.type === "create_edge") return !drop(op.edge.id) && !drop(op.edge.fromNodeID) && !drop(op.edge.toNodeID);
    return true;
  });
}

/** An undo cannot re-pin a node whose pin is still in flight. */
export function sanitizeVisualizerUndo(undoOps: VisualizerOp[], doOps: VisualizerOp[], inFlight: Transaction<VisualizerOp>[]): VisualizerOp[] {
  const pendingPins = new Set<string>();
  for (const t of inFlight) for (const op of t.doOps) if (op.type === "set_position") pendingPins.add(op.nodeID);
  if (pendingPins.size === 0) return undoOps;
  const unpinned = new Set(doOps.filter((o) => o.type === "delete_position").map((o) => (o as { nodeID: string }).nodeID));
  return undoOps.filter((op) => !(op.type === "set_position" && pendingPins.has(op.nodeID) && unpinned.has(op.nodeID)));
}

/** Visualizer: no refetch after a batch made only of position ops. */
export const visualizerRefetchAfterCommit = (ops: VisualizerOp[]) => !ops.every((o) => o.type === "set_position" || o.type === "delete_position");
