import { applyTraceOps, type Trace, type TraceDoc, type TraceEdge, type TraceOp } from "@osstrace/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { prepareTraceReplay, sanitizeTraceUndo, useOptimisticDocument } from "../optimistic/index.ts";
import { postTraceBatch, traceKeys, useAnonTraceShare, useTrace } from "./api.ts";

/** A new, empty local-only canvas -- no account, nothing saved anywhere (ADR 0025). Mirrors the
 * Visualizer's scratch mode (useVisualizerDocument.ts) exactly: `localOnly: true`, no `dispatch`,
 * seeded once and never refetched. */
export const SCRATCH_ID = "scratch";
export const emptyTraceDoc = (): TraceDoc => ({ title: "", notes: "", shareable: false, nodes: [], edges: [] });

export type TraceSource = { kind: "scratch"; initial: TraceDoc } | { kind: "saved"; id: string; readOnly: boolean } | { kind: "anonShare"; id: string };

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

const EPOCH = new Date(0).toISOString();

export function useTraceDocument(source: TraceSource) {
  const qc = useQueryClient();
  const saved = source.kind === "saved" ? { id: source.id, readOnly: source.readOnly } : null;
  const anonId = source.kind === "anonShare" ? source.id : undefined;

  const q = useTrace(saved?.id, saved?.readOnly ?? false);
  const anonQ = useAnonTraceShare(anonId);

  // Scratch doc is seeded once per mount (TracerRoute keys the page by route, so a real navigation
  // remounts this) -- never refetched, exactly like VisualizerHome's "Scratch" seed.
  const [scratchSeed] = useState(() => (source.kind === "scratch" ? source.initial : null));

  const remote = useMemo<TraceDoc | null>(() => {
    if (source.kind === "scratch") return scratchSeed;
    if (source.kind === "anonShare") return anonQ.data ? { title: anonQ.data.title, notes: anonQ.data.notes, shareable: true, nodes: anonQ.data.nodes, edges: anonQ.data.edges } : null;
    return q.data ? toDoc(q.data) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.kind, scratchSeed, anonQ.data, q.data]);

  const invalidate = useCallback(() => {
    if (!saved) return;
    void qc.invalidateQueries({ queryKey: traceKeys.one(saved.id, saved.readOnly) });
    void qc.invalidateQueries({ queryKey: traceKeys.all });
  }, [qc, saved]);

  const readOnly = source.kind === "anonShare" ? true : (saved?.readOnly ?? false);
  const { store, snap } = useOptimisticDocument<TraceDoc, TraceOp>({
    documentKey: source.kind === "saved" ? source.id : source.kind === "anonShare" ? `anon:${source.id}` : SCRATCH_ID,
    remote,
    remoteUpdatedAt: saved ? q.data?.updatedAt : EPOCH,
    localOnly: !saved,
    applyOps: (d, ops) => applyTraceOps(d, ops).doc,
    dispatch: saved
      ? async (ops) => {
          if (saved.readOnly) throw new Error("This trace is view only.");
          const r = await postTraceBatch(saved.id, ops);
          return { updatedAt: r.updatedAt };
        }
      : undefined,
    maxOpsPerRequest: 500,
    prepareReplay: prepareTraceReplay,
    sanitizeUndo: sanitizeTraceUndo,
    decorate: decorateTrace,
    invalidate,
    onError: (err, txn) => console.warn(`[tracer] batch failed for "${txn.label}"`, err),
  });
  const query = source.kind === "anonShare" ? anonQ : q;
  const trace = source.kind === "saved" ? q.data : undefined;
  return { query, trace, store, snap, invalidate, readOnly };
}
