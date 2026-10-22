import { applyVisualizerOps, type VisualizerDoc, type VisualizerOp, type VisualizerState, type VisualizerView } from "@osstrace/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { prepareVisualizerReplay, sanitizeVisualizerUndo, useOptimisticDocument, visualizerRefetchAfterCommit } from "../optimistic/index.ts";
import { postViewBatch, useView, viewKeys } from "./api.ts";

/** Keep referential identity of unchanged state parts so memoised graph data is not rebuilt. */
export function decorateView(next: VisualizerDoc, prev: VisualizerDoc | null): VisualizerDoc {
  if (!prev) return next;
  const s = { ...next.state } as Record<string, unknown>;
  let same = next.name === prev.name && next.shareable === prev.shareable;
  for (const k of Object.keys(s) as (keyof VisualizerState)[]) {
    if (JSON.stringify(s[k]) === JSON.stringify(prev.state[k])) s[k] = prev.state[k];
    else same = false;
  }
  if (same) return prev;
  return { ...next, state: s as VisualizerState };
}

export type ViewSource = { kind: "scratch"; initial: VisualizerState } | { kind: "saved"; id: string; readOnly: boolean };

export function useVisualizerDocument(source: ViewSource) {
  const qc = useQueryClient();
  const savedId = source.kind === "saved" ? source.id : null;
  const savedRo = source.kind === "saved" ? source.readOnly : false;
  const saved = useMemo(() => (savedId ? { id: savedId, readOnly: savedRo } : null), [savedId, savedRo]);
  const q = useView(saved?.id, saved?.readOnly ?? false);
  const [scratchSeed] = useState(() => (source.kind === "scratch" ? { doc: { name: "Scratch", shareable: false, state: source.initial } as VisualizerDoc, at: new Date(0).toISOString() } : null));
  const remote = useMemo<VisualizerDoc | null>(() => (saved ? (q.data ? { name: q.data.name, shareable: q.data.shareable, state: q.data.state } : null) : scratchSeed!.doc), [saved, q.data, scratchSeed]);
  const invalidate = useCallback(() => {
    if (!saved) return;
    void qc.invalidateQueries({ queryKey: viewKeys.one(saved.id, saved.readOnly) });
    void qc.invalidateQueries({ queryKey: viewKeys.all });
  }, [qc, saved]);
  const { store, snap } = useOptimisticDocument<VisualizerDoc, VisualizerOp>({
    documentKey: saved ? `view:${saved.id}` : "scratch",
    remote,
    remoteUpdatedAt: saved ? q.data?.updatedAt : scratchSeed!.at,
    localOnly: !saved,
    applyOps: (d, ops) => applyVisualizerOps(d, ops).doc,
    dispatch: saved
      ? async (ops) => {
          if (saved.readOnly) throw new Error("This view is view only.");
          const r = await postViewBatch(saved.id, ops);
          return { updatedAt: r.updatedAt };
        }
      : undefined,
    maxOpsPerRequest: 500,
    prepareReplay: prepareVisualizerReplay,
    sanitizeUndo: sanitizeVisualizerUndo,
    refetchAfterCommit: visualizerRefetchAfterCommit,
    decorate: decorateView,
    invalidate,
    onError: (err, txn) => console.warn(`[visualizer] batch failed for "${txn.label}"`, err),
  });
  const view: VisualizerView | undefined = q.data;
  return { query: q, view, store, snap };
}
