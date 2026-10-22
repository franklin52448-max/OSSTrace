import { applyTraceOps, type Trace, type TraceDoc, type TraceEdge, type TraceOp } from "@osstrace/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { prepareTraceReplay, sanitizeTraceUndo, useOptimisticDocument } from "../optimistic/index.ts";
import { postTraceBatch, traceKeys, useTrace } from "./api.ts";

const toDoc = (t: Trace): TraceDoc => ({ title: t.title, notes: t.notes, shareable: t.shareable, nodes: t.nodes ?? [], edges: t.edges ?? [] });

/** Keep `displayTransfer` from the previous local copy when a refetched edge lacks it. */
export function decorateTrace(next: TraceDoc, prev: TraceDoc | null): TraceDoc {
  if (!prev) return next;
  const old = new Map(prev.edges.map((e) => [e.id, e]));
  let changed = false;
  const edges = next.edges.map((e): TraceEdge => {
    if (e.kind !== "transfer" || e.displayTransfer) return e;
    const p = old.get(e.id);
    if (p?.kind === "transfer" && p.displayTransfer) {
      changed = true;
      return { ...e, displayTransfer: p.displayTransfer };
    }
    return e;
  });
  return changed ? { ...next, edges } : next;
}

export function useTraceDocument(id: string, readOnly: boolean) {
  const qc = useQueryClient();
  const q = useTrace(id, readOnly);
  const remote = useMemo(() => (q.data ? toDoc(q.data) : null), [q.data]);
  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: traceKeys.one(id, readOnly) });
    void qc.invalidateQueries({ queryKey: traceKeys.all });
  }, [qc, id, readOnly]);
  const { store, snap } = useOptimisticDocument<TraceDoc, TraceOp>({
    documentKey: id,
    remote,
    remoteUpdatedAt: q.data?.updatedAt,
    applyOps: (d, ops) => applyTraceOps(d, ops).doc,
    dispatch: async (ops) => {
      if (readOnly) throw new Error("This trace is view only.");
      const r = await postTraceBatch(id, ops);
      return { updatedAt: r.updatedAt };
    },
    maxOpsPerRequest: 500,
    prepareReplay: prepareTraceReplay,
    sanitizeUndo: sanitizeTraceUndo,
    decorate: decorateTrace,
    invalidate,
    onError: (err, txn) => console.warn(`[tracer] batch failed for "${txn.label}"`, err),
  });
  return { query: q, trace: q.data, store, snap, invalidate };
}
