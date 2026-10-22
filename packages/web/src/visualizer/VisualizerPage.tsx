import { type AddressInfo, type Transfer, type VisualizerOp, type VisualizerState } from "@osstrace/contract";
import * as Popover from "@radix-ui/react-popover";
import { Ban, Crosshair, Expand, ExternalLink, Eye, GitBranch, Maximize2, Minus, MousePointer2, Pin, Plus, Redo2, SlidersHorizontal, Undo2, UserMinus, UserPlus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../kit/api.ts";
import { Button, IconButton } from "../kit/Button.tsx";
import { Switch } from "../kit/Switch.tsx";
import { cn } from "../kit/cn.ts";
import { ErrorNotice } from "../kit/QueryState.tsx";
import { chunk, clientTimestamp } from "../optimistic/index.ts";
import { tokenOptions } from "../panels/model.ts";
import { useSafeToast } from "../panels/parts.tsx";
import { postTraceBatch } from "../tracer/api.ts";
import { ContextMenu, type MenuItem } from "../tracer/canvas/ContextMenu.tsx";
import { AddNodeDialog, ShareDialog, type AddTarget } from "../tracer/dialogs.tsx";
import { useCanvasTransfers, useCreateView, useEntityAddresses } from "./api.ts";
import { buildGraph, buildTraceSeedOps, extractNeighbourhood, TYPE_GROUPS, visibleStats, type GraphLink, type GraphNode, type Neighbour } from "./lib/graph.ts";
import { canvasTransfersQuery, parseBaseToken, serializeScratchParams, type BaseItem } from "./lib/urlState.ts";
import { readPalette, type Palette } from "./picture.ts";
import { useVisualizerDocument, type ViewSource } from "./useVisualizerDocument.ts";
import { VisualizerGraph, type GraphHandle } from "./VisualizerGraph.tsx";
import { baseFallbackLabel, ViewPanel } from "./ViewPanel.tsx";
import { VizInspector } from "./VizInspector.tsx";
import { centerForArea, freeArea, pointsBox } from "../tracer/lib/freeArea.ts";
import { SaveViewDialog, SendToTracerDialog } from "./vizDialogs.tsx";

type Tool = "default" | "expand" | "fix" | "add" | "remove";
const TOOLS: { key: Tool; label: string; hotkey: string; icon: typeof Expand }[] = [
  { key: "expand", label: "Expand / collapse entity", hotkey: "E", icon: Expand },
  { key: "fix", label: "Pin / unpin", hotkey: "P", icon: Pin },
  { key: "add", label: "Add to / remove from base", hotkey: "A", icon: UserPlus },
  { key: "remove", label: "Exclude from view", hotkey: "R", icon: UserMinus },
];
const VIEWPORTS_KEY = "osstrace_visualizer_viewports";
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 16;

function readViewport(key: string): { x: number; y: number; k: number } | null {
  try {
    const all = JSON.parse(localStorage.getItem(VIEWPORTS_KEY) ?? "{}") as Record<string, { v: { x: number; y: number; k: number }; t: number }>;
    return all[key]?.v ?? null;
  } catch {
    return null;
  }
}
function writeViewport(key: string, v: { x: number; y: number; k: number }) {
  try {
    const all = JSON.parse(localStorage.getItem(VIEWPORTS_KEY) ?? "{}") as Record<string, { v: unknown; t: number }>;
    all[key] = { v, t: Date.now() };
    const kept = Object.entries(all).sort((a, b) => b[1].t - a[1].t).slice(0, 50);
    localStorage.setItem(VIEWPORTS_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* not persisted */
  }
}

function usePalette() {
  const [pal, setPal] = useState<Palette>(() => readPalette());
  useEffect(() => {
    const mo = new MutationObserver(() => setPal(readPalette()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    return () => mo.disconnect();
  }, []);
  return pal;
}

/** The Visualizer canvas: scratch (URL-only) or a saved view, editable or read-only. */
export function VisualizerPage({ source }: { source: ViewSource }) {
  const toast = useSafeToast();
  const createView = useCreateView();
  const { query, view, store, snap } = useVisualizerDocument(source);
  const doc = snap.doc;
  const state = doc?.state ?? null;
  const scratch = source.kind === "scratch";
  const editable = scratch || (source.kind === "saved" && !source.readOnly && view?.isOwner !== false);
  const mode: "scratch" | "owner" | "shared" = scratch ? "scratch" : editable ? "owner" : "shared";
  // scratch viewports are remembered per base set, so a new scratch base never inherits another graph's camera
  const vpKey = source.kind === "saved" ? source.id : `scratch:${source.initial.base.map((b) => `${b.type}:${b.value}`).sort().join(",")}`;

  // ---------- URL sync (scratch): a silent History API write, so it never re-triggers our own
  // hash sub-router (only a real `hashchange` -- external navigation -- does that). ----------
  useEffect(() => {
    if (!scratch || !state) return;
    const qs = serializeScratchParams(state).toString();
    const hash = `#graph/scratch${qs ? `?${qs}` : ""}`;
    if (window.location.hash !== hash) history.replaceState(null, "", hash);
  }, [scratch, state]);

  // ---------- data ----------
  const entityIds = useMemo(() => (state?.base ?? []).filter((b) => b.type === "entity").map((b) => b.value), [state?.base]);
  const ents = useEntityAddresses(entityIds, true);
  const entKey = JSON.stringify([...ents.map]);
  const canvasQ = useMemo(() => (state ? canvasTransfersQuery(state, ents.map) : null), [state, entKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const transfersQ = useCanvasTransfers(canvasQ ?? { base: [] }, !!canvasQ && !ents.loading);
  const transfers = transfersQ.data?.transfers;

  const reuse = useRef(new Map<string, GraphNode>());
  const graph = useMemo(() => {
    if (!state) return { nodes: [], links: [], excludedLinks: 0 };
    const g = buildGraph({ transfers: transfers ?? [], state: { ...state, isHidden: {} }, reuse: reuse.current });
    reuse.current = new Map(g.nodes.map((n) => [n.id, n]));
    return g;
    // isHidden only affects visibility, not structure
  }, [transfers, state?.base, state?.expanded, state?.positions, state?.filter]); // eslint-disable-line react-hooks/exhaustive-deps
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);
  const isHidden = state?.isHidden ?? {};
  const visible = (n: GraphNode | undefined) => !!n && (n.isBase || !isHidden[n.group]);
  const visibleLinks = useMemo(
    () => graph.links.filter((l) => visible(byId.get(typeof l.source === "string" ? l.source : l.source.id)) && visible(byId.get(typeof l.target === "string" ? l.target : l.target.id))),
    [graph.links, byId, isHidden], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const stats = useMemo(() => visibleStats(visibleLinks), [visibleLinks]);
  const baseNodeIds = useMemo(() => new Set(graph.nodes.filter((n) => n.isBase).map((n) => n.id)), [graph.nodes]);
  const isBaseAddr = useCallback((a: AddressInfo) => {
    const k = `${a.chain}:${a.address}`;
    if (baseNodeIds.has(k)) return true;
    return !!a.entity && baseNodeIds.has(`entity:${a.entity.id}`);
  }, [baseNodeIds]);
  const rows = useMemo(() => visibleLinks.map((l) => l.tx), [visibleLinks]);
  const tokens = useMemo(() => tokenOptions(transfers ?? []), [transfers]);

  // ---------- ui state ----------
  const [tool, setTool] = useState<Tool>("default");
  // The graph is the hero: the transfers table starts closed (the Panels switch or clicking a link opens it).
  const [panels, setPanels] = useState(false);
  const [selected, setSelected] = useState<Transfer | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; node: GraphNode } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [send, setSend] = useState<{ origin: GraphNode; neighbours: Neighbour[] } | null>(null);
  const [zoomK, setZoomK] = useState(4);
  const palette = usePalette();
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fg = useRef<GraphHandle>(undefined);

  // ---------- edits ----------
  const run = useCallback(
    async (label: string, doOps: VisualizerOp[], undoOps: VisualizerOp[], pushToUndoStack = true) => {
      if (!editable) {
        toast.info("This view is view only.");
        return false;
      }
      const ok = await store.beginTransaction({ label, doOps, undoOps, pushToUndoStack });
      if (!ok) toast.error(`Could not save: ${label.toLowerCase()}.`);
      return ok;
    },
    [editable, store, toast],
  );
  const freeze = () => {
    for (const n of graph.nodes) if (!n.isPinned && n.x != null) Object.assign(n, { frozen: true, fx: n.x, fy: n.y });
  };
  const unfreeze = useCallback(() => {
    for (const n of reuse.current.values()) if (n.frozen) Object.assign(n, { frozen: false, fx: undefined, fy: undefined });
  }, []);
  const setBase = (base: BaseItem[], label: string) => state && run(label, [{ type: "set_base", base, clientTimestamp: clientTimestamp() }], [{ type: "set_base", base: state.base, clientTimestamp: clientTimestamp() }]);
  const baseOf = (n: GraphNode): BaseItem => (n.kind === "entity" && n.entity ? { type: "entity", value: n.entity.id, exclude: false } : { type: "address", value: n.id, exclude: false });
  const sameBase = (a: BaseItem, b: BaseItem) => a.type === b.type && a.value === b.value;

  const toggleExpand = (n: GraphNode) => {
    const entId = n.kind === "entity" ? n.entity?.id : n.info?.entity?.id;
    if (!entId || !state) return toast.info("Only addresses that belong to one of your entities can be expanded.");
    freeze();
    const ts = clientTimestamp();
    if (state.expanded.includes(entId)) void run("Collapse entity", [{ type: "remove_expanded", nodeID: entId, clientTimestamp: ts }], [{ type: "add_expanded", nodeID: entId, clientTimestamp: ts }]);
    else void run("Expand entity", [{ type: "add_expanded", nodeID: entId, clientTimestamp: ts }], [{ type: "remove_expanded", nodeID: entId, clientTimestamp: ts }]);
  };
  const togglePin = (n: GraphNode) => {
    if (!state) return;
    const prev = state.positions[n.id];
    const ts = clientTimestamp();
    if (prev) void run("Unpin node", [{ type: "delete_position", nodeID: n.id, clientTimestamp: ts }], [{ type: "set_position", nodeID: n.id, position: prev, clientTimestamp: ts }]);
    else if (n.x != null) {
      const pos = { x: Math.round(n.x), y: Math.round(n.y ?? 0) };
      void run("Pin node", [{ type: "set_position", nodeID: n.id, position: pos, clientTimestamp: ts }], [{ type: "delete_position", nodeID: n.id, clientTimestamp: ts }]);
    }
  };
  const toggleBase = (n: GraphNode) => {
    if (!state) return;
    const b = baseOf(n);
    freeze();
    if (state.base.some((x) => sameBase(x, b) && !x.exclude)) {
      if (state.base.filter((x) => !x.exclude).length <= 1) return toast.info("The last base node cannot be removed.");
      void setBase(state.base.filter((x) => !sameBase(x, b)), "Remove from view");
    } else void setBase([...state.base.filter((x) => !sameBase(x, b)), b], "Add to view");
  };
  const exclude = (n: GraphNode) => state && void setBase([...state.base.filter((x) => !sameBase(x, baseOf(n))), { ...baseOf(n), exclude: true }], "Exclude from view");
  const visualizeHere = (n: GraphNode) => {
    if (!state) return;
    const ts = clientTimestamp();
    const pins = Object.entries(state.positions);
    void run(
      "Visualize here",
      [{ type: "set_base", base: [baseOf(n)], clientTimestamp: ts }, ...pins.map(([nodeID]): VisualizerOp => ({ type: "delete_position", nodeID, clientTimestamp: ts }))],
      [{ type: "set_base", base: state.base, clientTimestamp: ts }, ...pins.map(([nodeID, position]): VisualizerOp => ({ type: "set_position", nodeID, position, clientTimestamp: ts }))],
    );
  };
  const setFilter = (f: Partial<VisualizerState["filter"]>) => state && void run("Change filter", [{ type: "set_filter", filter: { ...state.filter, ...f }, clientTimestamp: clientTimestamp() }], [{ type: "set_filter", filter: state.filter, clientTimestamp: clientTimestamp() }]);
  const setTime = (ms: number) => state && void run("Change time range", [{ type: "set_time_range", timeRange: ms ? { gte: Date.now() - ms, lte: null } : { gte: null, lte: null }, clientTimestamp: clientTimestamp() }], [{ type: "set_time_range", timeRange: state.timeRange, clientTimestamp: clientTimestamp() }]);
  const toggleGroupHidden = (key: string, hide: boolean) => state && void run(hide ? "Hide type" : "Show type", [{ type: "set_is_hidden_for_type", typeKey: key, isHiddenValue: hide, clientTimestamp: clientTimestamp() }], [{ type: "set_is_hidden_for_type", typeKey: key, isHiddenValue: !!state.isHidden[key], clientTimestamp: clientTimestamp() }]);

  const onNodeClick = (n: GraphNode) => {
    if (tool === "expand") toggleExpand(n);
    else if (tool === "fix") togglePin(n);
    else if (tool === "add") toggleBase(n);
    else if (tool === "remove") (n.isBase && state && state.base.filter((x) => !x.exclude).length <= 1 ? toast.info("The last base node cannot be excluded.") : exclude(n));
  };
  const onDragEnd = (n: GraphNode) => {
    if (!state) return;
    if (!editable) {
      const pin = state.positions[n.id];
      Object.assign(n, { fx: pin?.x, fy: pin?.y });
      toast.info("This view is view only: layout changes are not saved.");
      return;
    }
    const pos = { x: Math.round(n.x ?? 0), y: Math.round(n.y ?? 0) };
    const prev = state.positions[n.id];
    if (prev && prev.x === pos.x && prev.y === pos.y) return;
    const ts = clientTimestamp();
    void run(prev ? "Move node" : "Pin node", [{ type: "set_position", nodeID: n.id, position: pos, clientTimestamp: ts }], [prev ? { type: "set_position", nodeID: n.id, position: prev, clientTimestamp: ts } : { type: "delete_position", nodeID: n.id, clientTimestamp: ts }]);
  };

  const addFromSearch = (t: AddTarget) => {
    setAddOpen(false);
    if (!state) return;
    const b: BaseItem | null = t.type === "entity" ? { type: "entity", value: t.id, exclude: false } : parseBaseToken(`${t.chain}:${t.address}`);
    if (!b) return toast.error("That is not a valid address.");
    if (state.base.some((x) => sameBase(x, b) && !x.exclude)) return toast.info("Already in the view.");
    freeze();
    void setBase([...state.base.filter((x) => !sameBase(x, b)), b], "Add to view");
  };

  const traceFrom = (n: GraphNode) => setSend({ origin: n, neighbours: extractNeighbourhood(n, visibleLinks, byId) });
  const createTrace = async (picked: Neighbour[]) => {
    if (!send) return;
    const { id: traceId } = await api<{ id: string }>("/traces", { method: "POST", json: { title: send.origin.label } });
    try {
      for (const part of chunk(buildTraceSeedOps(traceId, send.origin, picked), 500)) await postTraceBatch(traceId, part);
    } catch (e) {
      toast.error("The trace was created, but seeding it from the graph failed.");
      console.warn(e);
    }
    window.location.hash = `#trace/doc/${traceId}`;
  };

  // ---------- zoom / viewport ----------
  /** Programmatic camera moves also fire onZoom; anything after this time counts as the user's own pan/zoom. */
  const progUntil = useRef(0);
  const userMoved = useRef(false);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  /** Space the floating panels and the bottom bar take from the canvas, measured from the DOM. */
  const panelInsets = () => {
    const c = containerRef.current?.getBoundingClientRect();
    if (!c) return {};
    const l = (leftRef.current?.firstElementChild as HTMLElement | null)?.getBoundingClientRect();
    const r = (rightRef.current?.firstElementChild as HTMLElement | null)?.getBoundingClientRect();
    return { left: l && l.width > 0 ? l.right - c.left + 16 : 0, right: r && r.width > 0 ? c.right - r.left + 16 : 0, top: 16, bottom: 68 };
  };
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const hiddenRef = useRef(isHidden);
  hiddenRef.current = isHidden;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  /** Centre and scale the visible graph inside the free canvas area (left of the inspector, right of the view panel). */
  const fitFree = useCallback((ms = 400) => {
    const g = fg.current;
    const { w, h } = sizeRef.current;
    if (!g || w === 0 || h === 0) return;
    const hidden = hiddenRef.current;
    // pad by the node radius plus room for the label under it
    const box = pointsBox(graphRef.current.nodes.filter((n) => n.isBase || !hidden[n.group]), 12);
    if (!box) return;
    const { cx, cy, k } = centerForArea(box, freeArea(w, h, panelInsets()), w, h, { min: ZOOM_MIN, max: 6 });
    progUntil.current = Date.now() + ms + 150;
    g.zoom(k, ms);
    g.centerAt(cx, cy, ms);
    userMoved.current = false;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const onReady = useCallback(() => {
    const g = fg.current;
    if (!g) return;
    const v = readViewport(vpKey);
    progUntil.current = Date.now() + 150;
    if (v) {
      g.centerAt(v.x, v.y);
      g.zoom(v.k);
      autoFit.current = false;
      userMoved.current = true;
    } else g.zoom(4);
  }, [vpKey]);
  /** Without a remembered viewport, fit the first settled layout once. */
  const autoFit = useRef(true);
  const onEngineStop = useCallback(() => {
    unfreeze();
    // wait for the transfers: a settle with only the base node would frame one disc at full zoom
    const loaded = !!transfersQ.data && !transfersQ.isFetching;
    if (autoFit.current && graph.nodes.length > 0 && (loaded || graph.nodes.length > 1)) {
      autoFit.current = false;
      fitFree(400);
    }
  }, [unfreeze, graph.nodes.length, fitFree, transfersQ.data, transfersQ.isFetching]);
  // re-fit when a panel opens or closes (the free area changed); wait one frame for the layout
  const inspectorShown = panels && rows.length > 0;
  const leftShown = !!(state && doc && !(size.w > 0 && size.w < 1024 && inspectorShown));
  const panelSig = `${inspectorShown ? 1 : 0}${leftShown ? 1 : 0}`;
  const lastSig = useRef(panelSig);
  useEffect(() => {
    if (lastSig.current === panelSig) return;
    lastSig.current = panelSig;
    if (autoFit.current) return; // the first fit has not happened yet and will use the new layout
    const id = requestAnimationFrame(() => fitFree(300));
    return () => cancelAnimationFrame(id);
  }, [panelSig, fitFree]);
  // window resize: keep the graph framed until the user has moved the camera themselves
  useEffect(() => {
    if (autoFit.current || userMoved.current) return;
    const t = setTimeout(() => fitFree(0), 120);
    return () => clearTimeout(t);
  }, [size.w, size.h, fitFree]);
  const vpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onZoom = useCallback(
    (t: { k: number; x: number; y: number }) => {
      setZoomK(t.k);
      if (Date.now() > progUntil.current) userMoved.current = true;
      if (vpTimer.current) clearTimeout(vpTimer.current);
      vpTimer.current = setTimeout(() => {
        const c = fg.current?.centerAt();
        if (c) writeViewport(vpKey, { x: c.x, y: c.y, k: t.k });
      }, 200);
    },
    [vpKey],
  );
  const zoomBy = (f: number) => {
    const g = fg.current;
    if (!g) return;
    g.zoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, g.zoom() * f)), 200);
  };
  const fitAll = () => fitFree(400);

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (document.querySelector("[role=dialog],[role=menu]")) return;
      if (e.defaultPrevented || (e.target as Element | null)?.closest?.("[role=dialog],[role=menu],[data-radix-popper-content-wrapper]")) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === "z" && !e.shiftKey) {
        e.preventDefault();
        void store.undo();
      } else if (mod && ((k === "z" && e.shiftKey) || k === "y")) {
        e.preventDefault();
        void store.redo();
      } else if (mod) return;
      else if (k === "escape") setTool("default");
      else if (k === "+" || k === "=") zoomBy(1.25);
      else if (k === "-" || k === "_") zoomBy(0.8);
      else if (k === "f" || k === "0") fitAll();
      else {
        const tl = TOOLS.find((x) => x.hotkey.toLowerCase() === k);
        if (tl && (editable || tl.key === "default")) setTool((cur) => (cur === tl.key ? "default" : tl.key));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const menuItems = (n: GraphNode): MenuItem[] => {
    const items: MenuItem[] = [];
    if (n.kind === "address" && n.chain && n.address) items.push({ kind: "item", label: "Open address page", icon: <ExternalLink />, onSelect: () => window.open(`#address/${n.chain}/${encodeURIComponent(n.address!)}`, "_blank", "noopener") });
    items.push({ kind: "item", label: "Trace from here", icon: <GitBranch />, onSelect: () => traceFrom(n) });
    if (!editable) return items;
    const entId = n.kind === "entity" ? n.entity?.id : n.info?.entity?.id;
    if (entId) items.push({ kind: "item", label: state?.expanded.includes(entId) ? "Collapse addresses" : "Expand addresses", onSelect: () => toggleExpand(n) });
    items.push({ kind: "item", label: n.isPinned ? "Unpin" : "Pin in place", icon: <Pin />, onSelect: () => togglePin(n) });
    items.push({ kind: "sep" });
    if (n.isBase) items.push({ kind: "item", label: "Remove from view", onSelect: () => toggleBase(n), disabled: (state?.base.filter((x) => !x.exclude).length ?? 0) <= 1 });
    else {
      items.push({ kind: "item", label: "Visualize here", icon: <Crosshair />, onSelect: () => visualizeHere(n) });
      items.push({ kind: "item", label: "Add to view", icon: <Plus />, onSelect: () => toggleBase(n) });
      items.push({ kind: "item", label: "Exclude from view", icon: <Ban />, danger: true, onSelect: () => exclude(n) });
    }
    return items;
  };

  const baseLabel = (b: BaseItem) => {
    if (b.type === "entity") return ents.names.get(b.value) ?? byId.get(`entity:${b.value}`)?.label ?? baseFallbackLabel(b);
    return byId.get(b.value)?.label ?? baseFallbackLabel(b);
  };

  if (query.error && !doc) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <ErrorNotice error={query.error} title={source.kind === "saved" && source.readOnly ? "This view is not public or does not exist" : "Could not load this view"} onRetry={() => void query.refetch()} />
      </div>
    );
  }

  const count = transfersQ.data?.count;
  const loaded = transfers?.length ?? 0;
  const loadedNote = count && count.value > loaded ? `Showing the latest ${loaded.toLocaleString("en-US")} of ${count.value.toLocaleString("en-US")}${count.capped ? "+" : ""} matching transfers.` : null;
  const cursor = tool === "default" ? "default" : tool === "fix" ? "copy" : "crosshair";
  const pill = "kit-dock flex h-10 items-center gap-0.5 px-1";

  return (
    <div className="relative h-full min-h-[480px] overflow-hidden bg-bg" onContextMenu={(e) => e.preventDefault()}>
      <div ref={containerRef} className="absolute inset-0" aria-label="Graph canvas" role="application">
        {state && size.w > 0 ? (
          <VisualizerGraph
            ref={fg}
            nodes={graph.nodes}
            links={graph.links}
            width={size.w}
            height={size.h}
            palette={palette}
            isHidden={isHidden}
            editable={editable}
            cursor={cursor}
            selectedLinkId={selected ? `${selected.chain}:${selected.id}` : null}
            onNodeClick={(n) => onNodeClick(n)}
            onNodeRightClick={(n, e) => setMenu({ x: e.clientX, y: e.clientY, node: n })}
            onLinkClick={(l: GraphLink) => {
              setSelected(l.tx);
              setPanels(true);
            }}
            onBackgroundClick={() => setMenu(null)}
            onNodeDragEnd={onDragEnd}
            onZoom={onZoom}
            onEngineStop={onEngineStop}
            onReady={onReady}
          />
        ) : null}
        {state && state.base.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="pointer-events-auto flex max-w-sm flex-col items-center gap-2 text-center">
              <span aria-hidden className="mb-3 flex size-16 items-center justify-center rounded-full border border-dashed border-border-strong">
                <span className="size-11 rounded-full border-2 border-dashed border-accent/60" />
              </span>
              <p className="text-[15px] font-semibold">Start with a node</p>
              <p className="text-[13px] text-muted">Add an address or one of your entities to see who it transacts with.</p>
              {editable ? <Button variant="primary" icon={<Plus aria-hidden className="size-3.5" />} onClick={() => setAddOpen(true)}>Add node</Button> : null}
            </div>
          </div>
        ) : null}
        {state && state.base.length > 0 && transfersQ.isFetching ? (
          <p className="kit-dock pointer-events-none absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-2 px-2.5 py-1 text-xs text-muted" role="status"><span aria-hidden className="size-1.5 rounded-full bg-accent" />Loading transfers…</p>
        ) : null}
        {transfersQ.error ? (
          <div className="absolute left-1/2 top-4 w-[min(520px,calc(100%-32px))] -translate-x-1/2">
            <ErrorNotice error={transfersQ.error} onRetry={() => void transfersQ.refetch()} />
          </div>
        ) : null}
        {!doc ? <p className="absolute inset-0 flex items-center justify-center text-[13px] text-muted">Loading view…</p> : null}
      </div>

      <div className="pointer-events-none absolute inset-x-4 bottom-[68px] top-4 flex items-stretch justify-between gap-4">
        <div ref={leftRef} className="flex min-h-0 flex-col items-start">
          {leftShown ? (
            <ViewPanel
              mode={mode}
              name={doc.name}
              onRename={(name) => void run("Rename view", [{ type: "set_name", name, clientTimestamp: clientTimestamp() }], [], false)}
              stats={stats}
              loadedNote={loadedNote}
              sync={transfersQ.data?.sync}
              state={state}
              baseLabel={baseLabel}
              editable={editable}
              onToggleExclude={(b) => void setBase(state.base.map((x) => (sameBase(x, b) ? { ...x, exclude: !x.exclude } : x)), b.exclude ? "Include in view" : "Exclude from view")}
              onRemoveBase={(b) => void setBase(state.base.filter((x) => !sameBase(x, b)), "Remove from view")}
              onTraceFrom={(b) => {
                const n = graph.nodes.find((x) => (b.type === "entity" ? x.entity?.id === b.value && x.kind === "entity" : x.id === b.value));
                if (n) traceFrom(n);
                else toast.info("That node is not on the canvas yet.");
              }}
              onFilter={setFilter}
              onTimePreset={setTime}
              tokenOptions={tokens}
              isSaving={snap.isSaving}
              lastSavedAt={snap.lastSavedAt}
              onSave={() => setSaveOpen(true)}
              onShare={() => setShareOpen(true)}
            />
          ) : null}
        </div>
        <div ref={rightRef} className="flex min-h-0">
          {inspectorShown ? <VizInspector rows={rows} isBase={isBaseAddr} selected={selected} onSelect={setSelected} onClose={() => setPanels(false)} /> : null}
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-4 bottom-4 flex flex-wrap items-end justify-between gap-2">
        <div className={cn(pill, "pointer-events-auto")}>
          {!editable ? (
            <>
              <span className="flex h-7 items-center gap-1.5 px-2 text-xs text-muted"><Eye aria-hidden className="size-3.5" />View only</span>
              <span aria-hidden className="kit-dock-sep" />
            </>
          ) : null}
          <div className="flex items-center gap-0.5" role="group" aria-label="Zoom">
            <IconButton size="sm" label="Zoom out (−)" onClick={() => zoomBy(0.8)}><Minus aria-hidden className="size-3.5" /></IconButton>
            <span className="kit-num w-11 text-center text-xs" aria-live="polite">{Math.round((zoomK / 4) * 100)}<span className="text-faint">%</span></span>
            <IconButton size="sm" label="Zoom in (+)" onClick={() => zoomBy(1.25)}><Plus aria-hidden className="size-3.5" /></IconButton>
            <IconButton size="sm" label="Fit to view (F)" onClick={fitAll}><Maximize2 aria-hidden className="size-3.5" /></IconButton>
          </div>
          <span aria-hidden className="kit-dock-sep" />
          <Popover.Root>
            <Popover.Trigger asChild>
              <Button size="sm" variant="ghost" icon={<SlidersHorizontal aria-hidden className="size-3.5" />}>Display</Button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content side="top" align="start" sideOffset={8} className="kit-overlay z-[70] w-72 p-0" data-state="open">
                <p className="kit-sect-h border-b border-border px-3 py-2">Node types</p>
                <ul className="flex flex-col py-1">
                  {TYPE_GROUPS.map((g) => (
                    <li key={g.key} className="flex h-8 items-center gap-2.5 px-3 text-[13px]">
                      <span aria-hidden className="size-3 rounded-full border-2 bg-surface-2" style={{ borderColor: g.color ? `var(${g.color})` : "var(--trace-border-strong)", borderWidth: g.color ? 2 : 1 }} />
                      <span className="flex-1">{g.label}</span>
                      <Switch checked={!isHidden[g.key]} disabled={!editable} label={`Show ${g.label}`} onCheckedChange={(v) => toggleGroupHidden(g.key, !v)} />
                    </li>
                  ))}
                </ul>
                <p className="kit-sect-h border-y border-border px-3 py-2">Edges</p>
                <ul className="flex flex-col gap-1.5 px-3 py-2.5 text-xs text-muted">
                  <li className="flex items-center gap-2.5"><span aria-hidden className="h-0.5 w-6 rounded-full bg-in" /> Into a base node</li>
                  <li className="flex items-center gap-2.5"><span aria-hidden className="h-0.5 w-6 rounded-full bg-out" /> Out of a base node</li>
                  <li className="flex items-center gap-2.5"><span aria-hidden className="h-px w-6 bg-border-strong" /> Between other nodes</li>
                  <li className="flex items-center gap-2.5"><span aria-hidden className="size-3 rounded-full border-2 border-accent" /> Base node (ring)</li>
                </ul>
                <p className="border-t border-border px-3 py-2 text-xs text-faint">Base nodes always show. Line width follows the USD value.</p>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <span aria-hidden className="kit-dock-sep" />
          <div className="flex items-center gap-2 px-1.5">
            <span className="text-xs text-muted">Panels</span>
            <Switch checked={panels} onCheckedChange={setPanels} label="Show panels" />
          </div>
        </div>
        <div className={cn(pill, "pointer-events-auto")} role="toolbar" aria-label="Graph tools">
          {editable ? (
            <>
              <IconButton size="sm" label={`Undo${snap.undoLabel ? `: ${snap.undoLabel}` : ""}`} disabled={!snap.canUndo} onClick={() => void store.undo()}><Undo2 aria-hidden className="size-3.5" /></IconButton>
              <IconButton size="sm" label={`Redo${snap.redoLabel ? `: ${snap.redoLabel}` : ""}`} disabled={!snap.canRedo} onClick={() => void store.redo()}><Redo2 aria-hidden className="size-3.5" /></IconButton>
              <span aria-hidden className="kit-dock-sep" />
            </>
          ) : null}
          <IconButton size="sm" label="Select (Esc)" aria-pressed={tool === "default"} onClick={() => setTool("default")} className={cn(tool === "default" && "bg-surface-2 text-text")}><MousePointer2 aria-hidden className="size-3.5" /></IconButton>
          {TOOLS.map((t) => (
            <IconButton key={t.key} size="sm" label={`${t.label} (${t.hotkey})`} aria-pressed={tool === t.key} disabled={!editable} onClick={() => setTool((c) => (c === t.key ? "default" : t.key))} className={cn(tool === t.key && "bg-accent-soft text-accent")}>
              <t.icon aria-hidden className="size-3.5" />
            </IconButton>
          ))}
          {editable ? (
            <>
              <span aria-hidden className="kit-dock-sep" />
              <Button variant="primary" size="sm" className="ml-0.5" icon={<Crosshair aria-hidden className="size-3.5" />} onClick={() => setAddOpen(true)}>Add</Button>
            </>
          ) : null}
        </div>
      </div>

      {menu ? <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.node)} onClose={() => setMenu(null)} label="Node actions" /> : null}
      {editable ? <AddNodeDialog open={addOpen} onOpenChange={setAddOpen} onPick={addFromSearch} /> : null}
      {scratch && state ? (
        <SaveViewDialog open={saveOpen} onOpenChange={setSaveOpen} defaultName={state.base[0] ? baseLabel(state.base[0]) : "Untitled view"} onSave={async (name) => {
          const r = await createView.mutateAsync({ name, state });
          setSaveOpen(false);
          toast.success("View saved");
          window.location.hash = `#graph/saved/${r.id}`;
        }} />
      ) : null}
      {mode === "owner" && doc && source.kind === "saved" ? (
        <ShareDialog kind="view" open={shareOpen} onOpenChange={setShareOpen} shareable={doc.shareable} url={`${window.location.origin}/#graph/public/${source.id}`}
          onShareable={(shareable) => run(shareable ? "Make view public" : "Make view private", [{ type: "set_shareable", shareable, clientTimestamp: clientTimestamp() }], [], false)} />
      ) : null}
      {send ? <SendToTracerDialog origin={send.origin} neighbours={send.neighbours} onClose={() => setSend(null)} onCreate={createTrace} /> : null}
    </div>
  );
}
