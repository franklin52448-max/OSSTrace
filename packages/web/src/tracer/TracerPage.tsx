import {
  addressNodeId,
  entityNodeId,
  type AggregateSummaryResponse,
  type Counterparty,
  type Settings,
  type TraceEdge,
  type TraceNode,
  type TraceOp,
  type Transfer,
  type XY,
} from "@osstrace/contract";
import { useQuery } from "@tanstack/react-query";
import { Copy, ExternalLink, Pencil, Plus, Scaling, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent } from "react";
import { explorerAddressUrl, explorerName } from "../explorers.ts";
import { api } from "../kit/api.ts";
import { Button } from "../kit/Button.tsx";
import { ErrorNotice } from "../kit/QueryState.tsx";
import { useServerSession } from "../serverSession.ts";
import { useSafeToast } from "../panels/parts.tsx";
import { subjectKey, type CounterpartyRow } from "../panels/model.ts";
import { createAnonTraceShare, refreshTraceEdge, useAggregateSummary } from "./api.ts";
import { ContextMenu, type MenuItem } from "./canvas/ContextMenu.tsx";
import { NODE_COLORS, nodeTitle } from "./canvas/NodeCard.tsx";
import { TracerCanvas, type Selection } from "./canvas/TracerCanvas.tsx";
import { AddNodeDialog, AnonShareDialog, EditLabelDialog, ShareDialog, type AddTarget } from "./dialogs.tsx";
import { Inspector, readInspectorWidth, NodeHeading, NodeInspector, PairHeading, PairInspector, SummaryInspector, type InspectorController } from "./Inspector.tsx";
import { groupSegments, summarize } from "./lib/edges.ts";
import { groupEntityEdit, ungroupEntityEdit } from "./lib/entityOps.ts";
import {
  addCounterpartyEdit,
  addTransfersEdit,
  aggregatePairEdit,
  colorEdit,
  edgesBetween,
  effectiveAddress,
  findNodeForAddress,
  hasTransfer,
  makeAddressNode,
  makeEntityNode,
  moveOps,
  pairsToCompare,
  removeEdit,
  sharedCounterparties,
  sizeEdit,
  summaryFromTransferEdges,
  type Edit,
} from "./lib/ops.ts";
import { occupiedRects, placeNear, sideForFlow } from "./lib/placement.ts";
import { boundingBox, clampScale, FIT_PADDING, loadViewport, nodeRect, rectsIntersect, saveViewport, screenRectOfNode, screenToWorld, zoomAt, type Viewport } from "./lib/viewport.ts";
import { Sidebar } from "./Sidebar.tsx";
import { Toolbar } from "./Toolbar.tsx";
import { SCRATCH_ID, useTraceDocument, type TraceSource } from "./useTraceDocument.ts";
import { fitTransform, freeArea, type Insets } from "./lib/freeArea.ts";

/** Fit node rects into the free canvas area (between the floating panels, above the bottom bar); never zooms past 100%. */
function fitFree(rects: { x: number; y: number; w: number; h: number }[], W: number, H: number, ins: Insets): Viewport | null {
  const bb = boundingBox(rects);
  if (!bb || W <= 0 || H <= 0) return null;
  const t = fitTransform(bb, freeArea(W, H, ins), { margin: FIT_PADDING, max: 1 });
  const scale = clampScale(t.scale);
  if (scale === t.scale) return t;
  return fitTransform(bb, freeArea(W, H, ins), { margin: FIT_PADDING, min: scale, max: scale });
}

const FLOW_DOTS_KEY = "osstrace_tracer_flow_dots";
const STALE_MS = 60 * 60 * 1000;

function useReducedMotion() {
  const [r, setR] = useState(() => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const m = matchMedia("(prefers-reduced-motion: reduce)");
    const f = () => setR(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  return r;
}

function useElementSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    const ro = new ResizeObserver(update);
    ro.observe(el);
    update();
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function readFlowDotsPref(): boolean | null {
  try {
    const v = localStorage.getItem(FLOW_DOTS_KEY);
    return v === null ? null : v === "true";
  } catch {
    return null;
  }
}

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
};

export function TracerPage({ source }: { source: TraceSource }) {
  const toast = useSafeToast();
  const { query, trace, store, snap, invalidate } = useTraceDocument(source);
  const id = source.kind === "saved" || source.kind === "anonShare" ? source.id : SCRATCH_ID;
  // Mirrors the old prop exactly: true only for a route that was never meant to be edited (a
  // public saved-trace view, or an anon share -- always read-only, see ADR 0025). A scratch
  // canvas is the one anon surface that IS editable.
  const readOnlyProp = source.kind === "saved" ? source.readOnly : source.kind === "anonShare";
  const readOnly = readOnlyProp || trace?.isOwner === false;
  const doc = snap.doc;
  const rootRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  /** Space taken by the floating sidebar / inspector, so fit and placement target the visible canvas. */
  const insets = () => {
    const l = leftRef.current;
    const r = rightRef.current;
    // a collapsed sidebar only covers a header strip: it does not take canvas width
    const lw = l && (l.firstElementChild as HTMLElement | null)?.offsetHeight! > 80 ? l.offsetWidth + 32 : 0;
    const rw = r && r.offsetWidth ? r.offsetWidth + 32 : 0;
    // top: panel offset; bottom: the toolbar row
    return { left: lw, right: rw, top: 16, bottom: 68 };
  };
  const size = useElementSize(rootRef);
  const [viewport, setViewportState] = useState<Viewport>({ x: 0, y: 0, scale: 1 });
  const vpReady = useRef(false);
  const [selection, setSelection] = useState<Selection>({ type: "none" });
  const [menu, setMenu] = useState<{ x: number; y: number; node: TraceNode } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [labelNode, setLabelNode] = useState<TraceNode | null>(null);
  const reducedMotion = useReducedMotion();
  const session = useServerSession();
  const signedIn = session.status === "signed-in";
  // Settings are account data -- an anon canvas (scratch or a read-only share) has no session to
  // fetch them for; the flowDots default below falls back to `true` the same way it already did
  // for any read-only view.
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<Settings>("/settings"), enabled: signedIn, staleTime: 60_000, retry: 0 });
  const [flowDotsLocal, setFlowDotsLocal] = useState<boolean | null>(readFlowDotsPref);
  const flowDots = (flowDotsLocal ?? settings.data?.preferences.flowDots ?? true) && !reducedMotion;
  const docRef = useRef(doc);
  docRef.current = doc;
  const selRef = useRef(selection);
  selRef.current = selection;

  const setViewport = useCallback((v: Viewport | ((v: Viewport) => Viewport)) => setViewportState(v), []);

  // ---------- initial viewport: stored, else fit; auto-select a lone node ----------
  useEffect(() => {
    if (vpReady.current || !doc || size.w === 0) return;
    vpReady.current = true;
    const stored = loadViewport(id);
    if (stored) setViewportState(stored);
    else {
      // the inspector opens right after (a lone node is auto-selected), so reserve its width before it is measurable
      const ins = insets();
      const right = doc.nodes.length === 1 ? Math.max(ins.right, readInspectorWidth() + 32) : ins.right;
      const fit = fitFree(doc.nodes.map(nodeRect), size.w, size.h, { ...ins, left: ins.left || 332, right });
      if (fit) setViewportState(fit);
      else setViewportState({ x: size.w / 2, y: size.h / 2, scale: 1 });
    }
    if (doc.nodes.length === 1) setSelection({ type: "nodes", nodeIDs: [doc.nodes[0]!.id] });
  }, [doc, size.w, size.h, id]);
  useEffect(() => {
    if (!vpReady.current) return;
    const t = setTimeout(() => saveViewport(id, viewport), 200);
    return () => clearTimeout(t);
  }, [viewport, id]);

  // drop selected ids that no longer exist
  useEffect(() => {
    if (!doc || selection.type !== "nodes") return;
    const alive = selection.nodeIDs.filter((x) => doc.nodes.some((n) => n.id === x));
    if (alive.length !== selection.nodeIDs.length) setSelection(alive.length ? { type: "nodes", nodeIDs: alive } : { type: "none" });
  }, [doc, selection]);

  // A scratch canvas lives in memory only (ADR 0025) -- nothing autosaves the way a signed-in
  // trace does, so leaving the page loses real work. Only warns once there's actually something to
  // lose (one node is enough; an untouched canvas has nothing worth a confirmation for).
  useEffect(() => {
    if (source.kind !== "scratch" || !doc || doc.nodes.length === 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [source.kind, doc]);

  const segments = useMemo(() => groupSegments(doc?.edges ?? []), [doc?.edges]);
  const overview = useMemo(() => summarize(doc?.edges ?? []), [doc?.edges]);
  const selectedIds = useMemo(() => new Set(selection.type === "nodes" ? selection.nodeIDs : []), [selection]);
  const selectedNodes = useMemo(() => (doc && selection.type === "nodes" ? selection.nodeIDs.map((x) => doc.nodes.find((n) => n.id === x)).filter((n): n is TraceNode => !!n) : []), [doc, selection]);

  // ---------- edits ----------
  const pendingNodeIds = () => {
    const s = new Set<string>();
    for (const t of store.getTransactions()) if (t.status === "in-flight") for (const op of t.doOps) if (op.type === "create_node") s.add(op.node.id);
    return s;
  };
  const run = useCallback(
    async (edit: Edit | null, opts: { pushToUndoStack?: boolean } = {}) => {
      if (!edit || edit.doOps.length === 0) return true;
      if (readOnly) {
        toast.info("This trace is view only.");
        return false;
      }
      const ok = await store.beginTransaction({ label: edit.label, doOps: edit.doOps, undoOps: edit.undoOps, pushToUndoStack: opts.pushToUndoStack });
      if (!ok) toast.error(`Could not save: ${edit.label.toLowerCase()}. ${snap.lastError ?? ""}`.trim());
      return ok;
    },
    [readOnly, store, toast, snap.lastError],
  );

  const visibleWorld = () => {
    const ins = insets();
    const l = size.w - ins.left - ins.right >= 240 ? ins.left : 0;
    const w = size.w - l - ins.right >= 240 ? size.w - l - ins.right : size.w;
    const left = w === size.w ? 0 : l;
    const tl = screenToWorld({ x: left, y: 0 }, viewport);
    return { x: tl.x, y: tl.y, w: w / viewport.scale, h: size.h / viewport.scale };
  };

  const onMoveEnd = useCallback(
    (from: Map<string, XY>, to: Map<string, XY>) => {
      if (readOnly) return;
      const doOps = moveOps(to);
      void store
        .beginTransaction({ label: "Move node", doOps, undoOps: [], pushToUndoStack: false })
        .then((ok) => !ok && toast.error(`Could not save the new position. ${snap.lastError ?? ""}`.trim()));
      store.pushUndoRecord({ label: to.size > 1 ? "Move nodes" : "Move node", doOps, undoOps: moveOps(from) });
    },
    [readOnly, store, toast, snap.lastError],
  );
  const onResizeEnd = useCallback((node: TraceNode, w: number) => void run(sizeEdit(node, w, null)), [run]);

  // ---------- find connections ----------
  const canIndirect = signedIn;
  const [indirectOn, setIndirectOn] = useState(false);
  const [finding, setFinding] = useState(false);
  const [indirectResults, setIndirectResults] = useState<{ a: TraceNode; b: TraceNode; shared: { key: string; address: string }[] }[] | null>(null);

  const findConnections = useCallback(async () => {
    if (!doc) return;
    const addrNodes = doc.nodes.filter((n) => n.kind === "address");
    if (addrNodes.length < 2) {
      toast.info("Add at least 2 address nodes to search for connections.");
      return;
    }
    const pairs = pairsToCompare(doc.nodes);
    if (pairs.length === 0) {
      toast.info("These nodes are on different chains, nothing to compare directly.");
      return;
    }

    setFinding(true);
    setIndirectResults(null);
    try {
      // Direct: a real transfer straight between the two nodes, found via the same counterparty-
      // filtered /transfers query the Inspector already uses -- not a bulk history pull, one small
      // query per pair, reusing whatever's already cached within its staleTime.
      const found: Transfer[] = [];
      for (const [a, b] of pairs) {
        try {
          const res = await api<{ transfers: Transfer[] }>("/transfers", {
            query: { base: [subjectKey(a.chain!, a.address!)], counterparties: [subjectKey(b.chain!, b.address!)], flow: "all", sortDir: "desc", limit: 200 },
          });
          found.push(...res.transfers);
        } catch {
          // one pair failing (rate limit, a provider hiccup) shouldn't abort the whole search
        }
      }
      let madeEdge = false;
      if (found.length) {
        const centroid = { x: addrNodes.reduce((s, n) => s + n.currentPosition.x, 0) / addrNodes.length, y: addrNodes.reduce((s, n) => s + n.currentPosition.y, 0) / addrNodes.length };
        const edit = addTransfersEdit({ traceId: id, doc, transfers: found, positionFor: () => centroid });
        madeEdge = await run(edit);
      }

      // Indirect: both nodes share a counterparty, even one not on the canvas -- a lead, not proof
      // of a relationship, so it's never drawn as a real edge. Signed-in only (ADR 0024's pattern).
      let indirectFound: NonNullable<typeof indirectResults> = [];
      if (indirectOn && canIndirect) {
        const cpSets = new Map<string, Map<string, string>>();
        for (const n of addrNodes) {
          const set = new Map<string, string>();
          for (const flow of ["in", "out"] as const) {
            try {
              const res = await api<{ counterparties: Counterparty[] }>(`/address/${n.chain}/${encodeURIComponent(n.address!)}/counterparties`, { query: { flow, limit: 100 } });
              for (const c of res.counterparties) set.set(subjectKey(c.address.chain, c.address.address), c.address.address);
            } catch {
              // ignore -- partial indirect results are still useful
            }
          }
          cpSets.set(n.id, set);
        }
        for (const [a, b] of pairs) {
          const setA = cpSets.get(a.id)!;
          const setB = cpSets.get(b.id)!;
          const selfKeys = new Set([subjectKey(a.chain!, a.address!), subjectKey(b.chain!, b.address!)]);
          const shared = sharedCounterparties(setA, setB, selfKeys);
          if (shared.length) indirectFound.push({ a, b, shared });
        }
        setIndirectResults(indirectFound);
      }

      if (!madeEdge && found.length === 0 && indirectFound.length === 0) toast.info("No connections found between these nodes.");
    } finally {
      setFinding(false);
    }
  }, [doc, id, run, toast, indirectOn, canIndirect]);

  const addTarget = (t: AddTarget) => {
    if (!doc) return;
    setAddOpen(false);
    let existing: TraceNode | undefined;
    if (t.type === "address") {
      const info = t.info ?? { address: t.address, chain: t.chain };
      existing = findNodeForAddress(id, doc, info) ?? doc.nodes.find((n) => n.id === safeId(() => addressNodeId(id, t.chain, t.address)));
    } else {
      existing = doc.nodes.find((n) => n.id === entityNodeId(id, t.id)) ?? doc.nodes.find((n) => n.displayAddress?.entity?.id === t.id);
    }
    if (existing) {
      setSelection({ type: "nodes", nodeIDs: [existing.id] });
      toast.info("Already on the canvas: selected it.");
      return;
    }
    const sel = selectedNodes.length === 1 ? selectedNodes[0]! : null;
    const vis = visibleWorld();
    const anchor = sel ?? [...doc.nodes].filter((n) => rectsIntersect(screenRectOfNode(n, viewport), { x: 0, y: 0, w: size.w, h: size.h })).sort((a, b) => b.currentPosition.x - a.currentPosition.x)[0];
    const pos = anchor ? placeNear({ base: nodeRect(anchor), side: "outflow", occupied: occupiedRects(doc.nodes), visible: vis }) : { x: vis.x + vis.w / 2 - 127, y: vis.y + vis.h / 2 - 36 };
    let node: TraceNode;
    try {
      node = t.type === "address" ? makeAddressNode(id, effectiveAddress(t.info ?? { address: t.address, chain: t.chain }), pos) : makeEntityNode(id, { id: t.id, name: t.name, source: "user" }, pos);
    } catch {
      toast.error("That is not a valid address.");
      return;
    }
    void run({ label: "Add node", doOps: [{ type: "create_node", node }], undoOps: [{ type: "delete_node", id: node.id }] });
    setSelection({ type: "nodes", nodeIDs: [node.id] });
  };

  const removeSelected = useCallback(() => {
    const d = docRef.current;
    const s = selRef.current;
    if (!d || s.type !== "nodes" || s.nodeIDs.length === 0) return;
    void run(removeEdit(d, s.nodeIDs, [], pendingNodeIds()));
    setSelection({ type: "none" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  // ---------- inspector controller ----------
  const counterpartyTarget = (row: CounterpartyRow) => (row.kind === "entity" ? doc?.nodes.find((n) => n.kind === "entity" && n.entityID === row.entity.id) : doc ? findNodeForAddress(id, doc, row.address) : undefined);
  const ctl: InspectorController = {
    readOnly,
    counterpartyState: (base, row) => {
      if (!doc) return "disabled";
      if (row.kind === "entity" && doc.nodes.some((n) => n.kind === "address" && n.displayAddress?.entity?.id === row.entity.id)) return "disabled";
      const target = counterpartyTarget(row);
      if (!target) return "add";
      if (target.id === base.id) return "disabled";
      if (row.kind === "address" && target.kind === "entity") return "disabled";
      return edgesBetween(doc, base.id, target.id).length ? "added" : "add";
    },
    addCounterparty: (base, row, flow) => {
      if (!doc) return;
      const side = sideForFlow(flow, row.stats.txOut, row.stats.txIn);
      const pos = placeNear({ base: nodeRect(base), side, occupied: occupiedRects(doc.nodes), visible: visibleWorld() });
      const edit = addCounterpartyEdit({ traceId: id, doc, base, counterparty: row.kind === "entity" ? { entity: row.entity } : row.address, stats: row.stats, position: pos });
      void run(edit);
    },
    removeCounterparty: (_base, row) => {
      const t = counterpartyTarget(row);
      if (doc && t) void run(removeEdit(doc, [t.id], [], pendingNodeIds()));
    },
    transferActions: (base) => {
      const stateOf = (t: Transfer) => {
        if (!doc) return "disabled" as const;
        if (hasTransfer(id, doc, t.chain, t.id)) return "added" as const;
        const a = findNodeForAddress(id, doc, t.from);
        const b = findNodeForAddress(id, doc, t.to);
        if (a && b && a.id === b.id) return "disabled" as const;
        const fa = effectiveAddress(t.from), fb = effectiveAddress(t.to);
        if (fa.chain === fb.chain && fa.address === fb.address) return "disabled" as const;
        return "add" as const;
      };
      const add = (ts: Transfer[]) => {
        if (!doc) return;
        const occ = occupiedRects(doc.nodes);
        const vis = visibleWorld();
        const baseIsFrom = (t: Transfer) => findNodeForAddress(id, doc, t.from)?.id === base.id;
        const edit = addTransfersEdit({
          traceId: id,
          doc,
          transfers: ts.filter((t) => stateOf(t) === "add"),
          positionFor: (_info, i) => {
            const t = ts.filter((x) => stateOf(x) === "add")[i]!;
            const p = placeNear({ base: nodeRect(base), side: baseIsFrom(t) ? "outflow" : "inflow", occupied: occ, visible: vis });
            occ.push({ x: p.x, y: p.y, w: 254, h: 72 });
            return p;
          },
        });
        void run(edit);
      };
      return {
        stateOf,
        onAdd: (t) => add([t]),
        onAddMany: (ts) => add(ts),
        onRemove: (t) => {
          if (!doc) return;
          const e = doc.edges.find((x) => x.kind === "transfer" && x.transferID === t.id && x.chain === t.chain);
          if (e) void run(removeEdit(doc, [], [e.id], pendingNodeIds()));
        },
      };
    },
    removeEdges: (edgeIds) => doc && void run(removeEdit(doc, [], edgeIds, pendingNodeIds())),
    aggregatePair: (a, b, summary) => {
      if (!doc) return;
      const s = summary
        ? { cachedUSDIn: summary.cachedUSDIn, cachedTransactionCountIn: summary.cachedTransactionCountIn, cachedUSDOut: summary.cachedUSDOut, cachedTransactionCountOut: summary.cachedTransactionCountOut, cachedAt: summary.cachedAt }
        : summaryFromTransferEdges(doc, a.id, b.id);
      const edit = aggregatePairEdit(id, doc, a.id, b.id, s);
      if (!edit) toast.info("No transfers between these nodes to aggregate.");
      else void run(edit);
    },
  };

  // ---------- pair summary + stale aggregate refresh ----------
  // Both of these call server endpoints that require an owned trace row (POST /traces/:id/
  // aggregate-summary, POST /traces/:id/edges/:edgeId/refresh) -- real for a saved trace, but a
  // scratch canvas's id is the constant SCRATCH_ID, not a real trace, and there's no session to
  // own one anyway. Computed client-side instead, from the edges already loaded in `doc` -- the
  // same fallback aggregatePairEdit (above) already uses when no server summary is available.
  const isScratch = source.kind === "scratch";
  const pair = selectedNodes.length === 2 && selectedNodes.every((n) => n.kind !== "transaction") ? (selectedNodes as [TraceNode, TraceNode]) : null;
  const serverSummaryQ = useAggregateSummary(id, pair?.[0].id ?? null, pair?.[1].id ?? null, !!pair && !readOnly && !isScratch);
  const localSummary = useMemo(() => {
    if (!isScratch || !pair || !doc) return null;
    const s = summaryFromTransferEdges(doc, pair[0].id, pair[1].id);
    return { ...s, sync: { state: "ready" as const, coveredFrom: null, provider: "local" } };
  }, [isScratch, pair, doc]);
  const summaryQ = isScratch ? { data: localSummary ?? undefined, error: null, isPending: false } : serverSummaryQ;
  const refreshed = useRef(new Set<string>());
  useEffect(() => {
    if (isScratch || !pair || !doc || readOnly || snap.isSaving) return;
    const agg = edgesBetween(doc, pair[0].id, pair[1].id).find((e): e is Extract<TraceEdge, { kind: "aggregate" }> => e.kind === "aggregate");
    if (!agg) return;
    const age = Date.now() - new Date(agg.aggregate.cachedAt).getTime();
    const key = `${agg.id}:${agg.aggregate.cachedAt}`;
    if (!(age > STALE_MS) || refreshed.current.has(key)) return;
    refreshed.current.add(key);
    refreshTraceEdge(id, agg.id)
      .then((edge) => store.patchRemote((d) => ({ ...d, edges: d.edges.map((e) => (e.id === edge.id ? edge : e)) })))
      .catch((err) => console.warn("[tracer] aggregate refresh failed", err));
  }, [isScratch, pair, doc, readOnly, snap.isSaving, id, store]);

  // ---------- zoom helpers ----------
  const center = () => ({ x: size.w / 2, y: size.h / 2 });
  const zoomBy = (f: number) => setViewport((v) => zoomAt(v, v.scale * f, center()));
  const fit = useCallback(() => {
    const d = docRef.current;
    if (!d || d.nodes.length === 0) return;
    const s = selRef.current;
    const sel = s.type === "nodes" ? d.nodes.filter((n) => s.nodeIDs.includes(n.id)) : [];
    const v = fitFree((sel.length ? sel : d.nodes).map(nodeRect), size.w, size.h, insets());
    if (v) setViewport(v);
  }, [size.w, size.h, setViewport]);

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || document.querySelector("[role=dialog],[role=menu]")) return;
      if (e.defaultPrevented || (e.target as Element | null)?.closest?.("[role=dialog],[role=menu],[data-radix-popper-content-wrapper]")) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key;
      if (mod && k.toLowerCase() === "a") {
        e.preventDefault();
        const d = docRef.current;
        if (d?.nodes.length) setSelection({ type: "nodes", nodeIDs: d.nodes.map((n) => n.id) });
      } else if (mod && k.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        if (!readOnly) void store.undo();
      } else if (mod && ((k.toLowerCase() === "z" && e.shiftKey) || k.toLowerCase() === "y")) {
        e.preventDefault();
        if (!readOnly) void store.redo();
      } else if (mod) return;
      else if (k === "+" || k === "=") zoomBy(1.25);
      else if (k === "-" || k === "_") zoomBy(0.8);
      else if (k === "0" || k.toLowerCase() === "f") fit();
      else if (k === "Escape") setSelection({ type: "none" });
      else if ((k === "Delete" || k === "Backspace") && !readOnly) {
        e.preventDefault();
        removeSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---------- context menu ----------
  const onNodeContextMenu = useCallback((e: RMouseEvent, node: TraceNode) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, node });
    if (!selRef.current || selRef.current.type !== "nodes" || !selRef.current.nodeIDs.includes(node.id)) setSelection({ type: "nodes", nodeIDs: [node.id] });
  }, []);
  const menuItems = (node: TraceNode): MenuItem[] => {
    const items: MenuItem[] = [];
    if (node.kind === "address" && node.chain && node.address) {
      items.push({ kind: "item", label: "Open address page", icon: <ExternalLink />, onSelect: () => window.open(`#address/${node.chain}/${encodeURIComponent(node.address!)}`, "_blank", "noopener") });
      items.push({ kind: "item", label: `View on ${explorerName(node.chain!)}`, icon: <ExternalLink />, onSelect: () => window.open(explorerAddressUrl(node.chain!, node.address!), "_blank", "noopener") });
      items.push({ kind: "item", label: "Copy address", icon: <Copy />, onSelect: () => void navigator.clipboard?.writeText(node.address!).then(() => toast.success("Address copied"), () => toast.error("Clipboard is blocked")) });
    }
    if (readOnly) return items;
    if (node.kind === "address") items.push({ kind: "item", label: node.displayAddress?.label ? "Edit label" : "Add label", icon: <Pencil />, onSelect: () => setLabelNode(node) });
    if (node.width) items.push({ kind: "item", label: "Reset size", icon: <Scaling />, onSelect: () => void run(sizeEdit(node, null, null)) });
    const targets = selectedNodes.some((n) => n.id === node.id) ? selectedNodes : [node];
    items.push({ kind: "sep" });
    items.push({
      kind: "swatches",
      label: "Node color",
      items: [
        { key: "default", label: "Default", color: null, active: !node.color, onSelect: () => void run(colorEdit(targets, null)) },
        ...NODE_COLORS.map((c) => ({ key: c.value, label: c.label, color: `var(--trace-node-${c.value})`, active: node.color === c.value, onSelect: () => void run(colorEdit(targets, c.value)) })),
      ],
    });
    items.push({ kind: "sep" });
    items.push({ kind: "item", label: targets.length > 1 ? `Remove ${targets.length} nodes` : "Remove node", icon: <Trash2 />, danger: true, onSelect: () => doc && void run(removeEdit(doc, targets.map((t) => t.id), [], pendingNodeIds())) });
    return items;
  };

  // ---------- group / ungroup ----------
  const groupCtl = (() => {
    if (readOnly || !doc || selectedNodes.length !== 1) return null;
    const n = selectedNodes[0]!;
    if (n.kind === "entity") {
      const r = ungroupEntityEdit(id, doc, n);
      return { mode: "ungroup" as const, disabledReason: "refused" in r ? r.refused : null, onClick: () => !("refused" in r) && void run(r) };
    }
    const ent = n.displayAddress?.entity;
    if (n.kind === "address" && ent) {
      const r = groupEntityEdit(id, doc, ent);
      return { mode: "group" as const, disabledReason: "refused" in r ? r.refused : null, onClick: () => !("refused" in r) && void run(r) };
    }
    return null;
  })();

  // ---------- render ----------
  if (query.error && !doc) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <ErrorNotice error={query.error} title={readOnlyProp ? "This trace is not public or does not exist" : "Could not load this trace"} onRetry={() => void query.refetch()} />
        {!readOnlyProp ? <a href="#trace" className="mt-3 inline-block text-[13px] text-accent underline">Back to traces</a> : null}
      </div>
    );
  }

  const narrow = size.w > 0 && size.w < 1024;
  const inspector =
    doc && selection.type === "summary" ? (
      <Inspector title="Added transfers" onClose={() => setSelection({ type: "none" })}>
        <SummaryInspector doc={doc} ctl={ctl} />
      </Inspector>
    ) : doc && selectedNodes.length === 1 ? (
      <Inspector title={nodeTitle(selectedNodes[0]!).title} heading={<NodeHeading node={selectedNodes[0]!} />} onClose={() => setSelection({ type: "none" })}>
        <NodeInspector node={selectedNodes[0]!} ctl={ctl} />
      </Inspector>
    ) : doc && pair ? (
      <Inspector title={`${nodeTitle(pair[0]).title} ↔ ${nodeTitle(pair[1]).title}`} heading={<PairHeading a={pair[0]} b={pair[1]} />} onClose={() => setSelection({ type: "none" })}>
        <PairInspector a={pair[0]} b={pair[1]} doc={doc} ctl={ctl} summary={summaryQ as { data?: AggregateSummaryResponse; error: unknown; isPending: boolean }} />
      </Inspector>
    ) : null;

  return (
    <div className="relative h-full min-h-[480px] overflow-hidden bg-bg">
      <TracerCanvas
        rootRef={rootRef}
        nodes={doc?.nodes ?? []}
        segments={segments}
        viewport={viewport}
        onViewport={setViewport}
        selection={selection}
        onSelection={setSelection}
        editable={!readOnly}
        showDots={flowDots}
        onMoveEnd={onMoveEnd}
        onResizeEnd={onResizeEnd}
        onNodeContextMenu={onNodeContextMenu}
      >
        {doc && doc.nodes.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="pointer-events-auto flex max-w-sm flex-col items-center gap-2 text-center">
              <div aria-hidden className="mb-3 flex h-[72px] w-[254px] items-center gap-3 rounded-[var(--trace-radius-lg)] border border-dashed border-border-strong bg-surface/60 px-3">
                <span className="size-10 shrink-0 rounded-[7px] border border-dashed border-border-strong" />
                <span className="flex flex-1 flex-col gap-2">
                  <span className="kit-skeleton h-2.5 w-32 [animation:none]" />
                  <span className="kit-skeleton h-2.5 w-16 [animation:none]" />
                </span>
              </div>
              <p className="text-[15px] font-semibold">Start with a node</p>
              <p className="text-[13px] text-muted">Add an address or one of your entities, then follow its counterparties and transfers.</p>
              {!readOnly ? <Button variant="primary" icon={<Plus aria-hidden className="size-3.5" />} onClick={() => setAddOpen(true)}>Add node</Button> : null}
            </div>
          </div>
        ) : null}
        {!doc ? <p className="absolute inset-0 flex items-center justify-center text-[13px] text-muted">Loading trace…</p> : null}
      </TracerCanvas>

      <div className="pointer-events-none absolute inset-x-4 bottom-[68px] top-4 flex items-stretch justify-between gap-4">
        <div ref={leftRef} className="flex min-h-0 flex-col items-start">
          {doc && !(narrow && inspector) ? (
            <Sidebar
              doc={doc}
              overview={overview}
              readOnly={readOnly}
              selectedIds={selectedIds}
              summarySelected={selection.type === "summary"}
              onSelectSummary={() => setSelection({ type: "summary" })}
              onSelectNode={(n, additive) => {
                const cur = selection.type === "nodes" ? selection.nodeIDs : [];
                setSelection(additive ? { type: "nodes", nodeIDs: cur.includes(n.id) ? cur.filter((x) => x !== n.id) : [...cur, n.id] } : { type: "nodes", nodeIDs: [n.id] });
              }}
              onTitle={(title) => void run({ label: "Rename trace", doOps: [{ type: "set_title", title }], undoOps: [] }, { pushToUndoStack: false })}
              onNotes={(notes) => run({ label: "Save notes", doOps: [{ type: "set_notes", notes }], undoOps: [] }, { pushToUndoStack: false })}
              onAdd={() => setAddOpen(true)}
              isSaving={snap.isSaving}
              lastSavedAt={snap.lastSavedAt}
              backHref={readOnlyProp ? "#" : "#trace"}
              autoCollapse={!!inspector && size.w < 1200}
            />
          ) : null}
        </div>
        <div ref={rightRef} className="flex min-h-0">{inspector}</div>
      </div>

      <Toolbar
        className="absolute inset-x-4 bottom-4"
        readOnly={readOnly}
        scale={viewport.scale}
        onZoomIn={() => zoomBy(1.25)}
        onZoomOut={() => zoomBy(0.8)}
        onFit={fit}
        onScale={(s) => setViewport((v) => zoomAt(v, clampScale(s), center()))}
        flowDots={flowDots}
        reducedMotion={reducedMotion}
        onFlowDots={(v) => {
          setFlowDotsLocal(v);
          try {
            localStorage.setItem(FLOW_DOTS_KEY, String(v));
          } catch {
            /* not persisted */
          }
        }}
        onShare={() => setShareOpen(true)}
        canUndo={snap.canUndo}
        canRedo={snap.canRedo}
        undoLabel={snap.undoLabel}
        redoLabel={snap.redoLabel}
        onUndo={() => void store.undo()}
        onRedo={() => void store.redo()}
        canDelete={selectedNodes.length > 0}
        onDelete={removeSelected}
        onAdd={() => setAddOpen(true)}
        group={groupCtl}
        onFindConnections={() => void findConnections()}
        finding={finding}
        indirectOn={indirectOn}
        onIndirectOn={setIndirectOn}
        indirectLocked={!canIndirect}
      />
      {indirectResults ? (
        <div className="pointer-events-auto absolute bottom-16 left-1/2 z-20 w-[min(92vw,420px)] -translate-x-1/2 rounded-[14px] border border-line bg-panel/95 p-3 shadow-card backdrop-blur-md">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-[13px] font-semibold">
              {indirectResults.length ? `${indirectResults.length} possible indirect link${indirectResults.length === 1 ? "" : "s"}` : "No indirect links found"}
            </p>
            <button type="button" onClick={() => setIndirectResults(null)} className="text-xs text-faint hover:text-muted">
              Dismiss
            </button>
          </div>
          {indirectResults.length ? (
            <ul className="max-h-48 space-y-2 overflow-y-auto text-[12px]">
              {indirectResults.map((r, i) => (
                <li key={i} className="rounded-sm border border-dashed border-line px-2 py-1.5">
                  <span className="font-medium">{nodeTitle(r.a).title}</span> <span className="text-faint">⇢ shared ⇢</span> <span className="font-medium">{nodeTitle(r.b).title}</span>
                  <p className="mt-0.5 text-faint">
                    Not a direct transfer — both sent to or received from: {r.shared.slice(0, 3).map((s) => s.address).join(", ")}
                    {r.shared.length > 3 ? ` (+${r.shared.length - 3} more)` : ""}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-faint">These nodes share no common counterparty either.</p>
          )}
        </div>
      ) : null}

      {menu ? <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.node)} onClose={() => setMenu(null)} label="Node actions" /> : null}
      {!readOnly ? <AddNodeDialog open={addOpen} onOpenChange={setAddOpen} onPick={addTarget} /> : null}
      {!readOnly && doc && source.kind === "scratch" ? (
        <AnonShareDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          onCreate={async () => {
            const r = await createAnonTraceShare({ title: doc.title, notes: doc.notes, nodes: doc.nodes, edges: doc.edges });
            return { url: `${window.location.origin}/#trace/anon/${r.id}`, expiresAt: r.expiresAt };
          }}
        />
      ) : null}
      {!readOnly && doc && source.kind === "saved" ? (
        <ShareDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          shareable={doc.shareable}
          url={`${window.location.origin}/#trace/view/${id}`}
          onShareable={(shareable) => run({ label: shareable ? "Make trace public" : "Make trace private", doOps: [{ type: "set_shareable", shareable } as TraceOp], undoOps: [] }, { pushToUndoStack: false })}
        />
      ) : null}
      <EditLabelDialog node={labelNode} onClose={() => setLabelNode(null)} onSaved={() => { invalidate(); toast.success("Label saved"); }} />
    </div>
  );
}

function safeId(f: () => string): string | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}
