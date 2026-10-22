import type { TraceNode, XY } from "@osstrace/contract";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { cn } from "../../kit/cn.ts";
import type { Segment } from "../lib/edges.ts";
import { gridLayers, rectFromPoints, rectsIntersect, resizeWidth, screenRectOfNode, wheelFactor, zoomAt, type Rect, type Viewport } from "../lib/viewport.ts";
import { EdgeLayer } from "./EdgeLayer.tsx";
import { NodeCard } from "./NodeCard.tsx";

export type Selection = { type: "none" } | { type: "summary" } | { type: "nodes"; nodeIDs: string[] };

/** Above this many nodes the canvas switches to one transformed world layer (no per-card re-render on pan/zoom). */
export const WORLD_LAYER_THRESHOLD = 200;
const IDENTITY: Viewport = { x: 0, y: 0, scale: 1 };
const DRAG_THRESHOLD = 3;

type Gesture =
  | { kind: "pan"; start: XY; startViewport: Viewport; moved: boolean }
  | { kind: "lasso"; start: XY; selectionAtStart: string[]; moved: boolean }
  | { kind: "drag"; start: XY; ids: string[]; startPos: Map<string, XY>; grabbed: string; additive: boolean; selectionAtStart: Selection; moved: boolean; pairSelect?: string[] }
  | { kind: "resize"; start: XY; node: TraceNode; startW: number; startH: number; moved: boolean };

export type TracerCanvasProps = {
  nodes: TraceNode[];
  segments: Segment[];
  viewport: Viewport;
  onViewport: (v: Viewport | ((v: Viewport) => Viewport)) => void;
  selection: Selection;
  onSelection: (s: Selection) => void;
  editable: boolean;
  showDots: boolean;
  onMoveEnd: (from: Map<string, XY>, to: Map<string, XY>) => void;
  onResizeEnd: (node: TraceNode, width: number) => void;
  onNodeContextMenu: (e: RMouseEvent, node: TraceNode) => void;
  children?: ReactNode;
  rootRef: React.RefObject<HTMLDivElement | null>;
};

export function TracerCanvas(props: TracerCanvasProps) {
  const { nodes, segments, viewport, onViewport, selection, onSelection, editable, showDots, onMoveEnd, onResizeEnd, onNodeContextMenu, children, rootRef } = props;
  const [drag, setDrag] = useState<Map<string, XY> | null>(null);
  const [resize, setResize] = useState<{ id: string; w: number } | null>(null);
  const [lasso, setLasso] = useState<Rect | null>(null);
  const [mode, setMode] = useState<Gesture["kind"] | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const vpRef = useRef(viewport);
  vpRef.current = viewport;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const selRef = useRef(selection);
  selRef.current = selection;

  const worldMode = nodes.length > WORLD_LAYER_THRESHOLD;
  const cardViewport = worldMode ? IDENTITY : viewport;

  const displayNodes = useMemo(() => (drag ? nodes.map((n) => (drag.has(n.id) ? { ...n, currentPosition: drag.get(n.id)! } : n)) : nodes), [nodes, drag]);
  const nodeMap = useMemo(() => {
    const m = new Map(displayNodes.map((n) => [n.id, n]));
    if (resize) {
      const n = m.get(resize.id);
      if (n) m.set(n.id, { ...n, width: resize.w, height: null });
    }
    return m;
  }, [displayNodes, resize]);
  const selectedIds = useMemo(() => new Set(selection.type === "nodes" ? selection.nodeIDs : []), [selection]);
  const selectedPair = selection.type === "nodes" && selection.nodeIDs.length === 2 ? [...selection.nodeIDs].sort().join("__") : null;

  // ---------- wheel: non-passive, anchored at the cursor; side panels scroll unless ctrl (pinch) ----------
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const t = e.target as HTMLElement | null;
      if (!e.ctrlKey && t?.closest("[data-canvas-scroll-region]")) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const f = wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey);
      onViewport((v) => zoomAt(v, v.scale * f, anchor));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [rootRef, onViewport]);

  const local = (e: { clientX: number; clientY: number }): XY => {
    const r = rootRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onMove = useCallback(
    (e: PointerEvent) => {
      const g = gesture.current;
      if (!g) return;
      const p = local(e);
      const dx = p.x - g.start.x;
      const dy = p.y - g.start.y;
      if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      g.moved = true;
      const v = vpRef.current;
      if (g.kind === "pan") onViewport({ ...g.startViewport, x: g.startViewport.x + dx, y: g.startViewport.y + dy });
      else if (g.kind === "lasso") setLasso(rectFromPoints(g.start, p));
      else if (g.kind === "drag" && editable) {
        const m = new Map<string, XY>();
        for (const [id, s] of g.startPos) m.set(id, { x: s.x + dx / v.scale, y: s.y + dy / v.scale });
        setDrag(m);
      } else if (g.kind === "resize") setResize({ id: g.node.id, w: resizeWidth(g.startW, g.startH, dx / v.scale, dy / v.scale) });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editable, onViewport],
  );

  const finish = useCallback(
    (e: PointerEvent) => {
      const g = gesture.current;
      gesture.current = null;
      setMode(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (!g) return;
      const v = vpRef.current;
      if (g.kind === "pan") {
        if (!g.moved) onSelection({ type: "none" });
      } else if (g.kind === "lasso") {
        const r = g.moved ? rectFromPoints(g.start, local(e)) : null;
        setLasso(null);
        if (r) {
          const hit = nodesRef.current.filter((n) => rectsIntersect(screenRectOfNode(n, v), r)).map((n) => n.id);
          const ids = [...new Set([...g.selectionAtStart, ...hit])];
          onSelection(ids.length ? { type: "nodes", nodeIDs: ids } : { type: "none" });
        } else onSelection(g.selectionAtStart.length ? { type: "nodes", nodeIDs: g.selectionAtStart } : { type: "none" });
      } else if (g.kind === "drag") {
        if (g.moved && editable) {
          const p = local(e);
          const to = new Map<string, XY>();
          for (const [id, s] of g.startPos) to.set(id, { x: Math.round(s.x + (p.x - g.start.x) / v.scale), y: Math.round(s.y + (p.y - g.start.y) / v.scale) });
          onMoveEnd(g.startPos, to);
          // dragging never changes the selection
          onSelection(g.selectionAtStart);
        } else if (g.pairSelect) {
          onSelection({ type: "nodes", nodeIDs: g.pairSelect });
        } else if (!g.moved) {
          const cur = selRef.current.type === "nodes" ? selRef.current.nodeIDs : [];
          if (g.additive) {
            const next = cur.includes(g.grabbed) ? cur.filter((x) => x !== g.grabbed) : [...cur, g.grabbed];
            onSelection(next.length ? { type: "nodes", nodeIDs: next } : { type: "none" });
          } else onSelection({ type: "nodes", nodeIDs: [g.grabbed] });
        }
        setDrag(null);
      } else if (g.kind === "resize") {
        setResize(null);
        if (g.moved) {
          const p = local(e);
          onResizeEnd(g.node, Math.round(resizeWidth(g.startW, g.startH, (p.x - g.start.x) / v.scale, (p.y - g.start.y) / v.scale)));
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onMove, editable, onSelection, onMoveEnd, onResizeEnd],
  );

  const begin = (g: Gesture) => {
    gesture.current = g;
    setMode(g.kind);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };
  useEffect(
    () => () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    },
    [onMove, finish],
  );

  const onBackgroundDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t !== e.currentTarget && !t.dataset.canvasBg) return;
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();
    const start = local(e);
    if (e.shiftKey) begin({ kind: "lasso", start, selectionAtStart: selection.type === "nodes" ? selection.nodeIDs : [], moved: false });
    else begin({ kind: "pan", start, startViewport: viewport, moved: false });
  };

  const onNodeDown = useCallback(
    (e: RPointerEvent, node: TraceNode) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const start = local(e);
      begin({
        kind: "drag",
        start,
        ids: [node.id],
        startPos: new Map([[node.id, { ...node.currentPosition }]]),
        grabbed: node.id,
        additive: e.shiftKey,
        selectionAtStart: selRef.current,
        moved: false,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onMove, finish],
  );

  const onSegmentDown = useCallback(
    (e: RPointerEvent, seg: Segment) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const pair = [seg.fromNodeID, seg.toNodeID];
      const cur = selRef.current.type === "nodes" ? selRef.current.nodeIDs : [];
      const ids = pair.every((id) => cur.includes(id)) ? cur : pair;
      const startPos = new Map<string, XY>();
      for (const id of ids) {
        const n = nodesRef.current.find((x) => x.id === id);
        if (n) startPos.set(id, { ...n.currentPosition });
      }
      begin({ kind: "drag", start: local(e), ids, startPos, grabbed: seg.fromNodeID, additive: false, selectionAtStart: { type: "nodes", nodeIDs: pair }, moved: false, pairSelect: pair });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onMove, finish],
  );

  const onResizeStart = useCallback(
    (e: RPointerEvent, node: TraceNode) => {
      if (e.button !== 0 || !editable) return;
      const w = node.width ?? 254;
      const h = node.height ?? (w * 72) / 254;
      begin({ kind: "resize", start: local(e), node, startW: w, startH: h, moved: false });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editable, onMove, finish],
  );

  const onActivate = useCallback(
    (node: TraceNode, additive: boolean) => {
      const cur = selRef.current.type === "nodes" ? selRef.current.nodeIDs : [];
      if (additive) onSelection({ type: "nodes", nodeIDs: cur.includes(node.id) ? cur.filter((x) => x !== node.id) : [...cur, node.id] });
      else onSelection({ type: "nodes", nodeIDs: [node.id] });
    },
    [onSelection],
  );

  const grid = gridLayers(viewport.scale);
  const bg: CSSProperties = {
    backgroundImage: `radial-gradient(circle at 1.15px 1.15px, color-mix(in srgb, var(--trace-grid-dot) ${Math.round(grid.opacityBig * 166)}%, transparent) 1.15px, transparent 1.25px), radial-gradient(circle at 1.15px 1.15px, color-mix(in srgb, var(--trace-grid-dot) ${Math.round(grid.opacitySmall * 166)}%, transparent) 1.15px, transparent 1.25px)`,
    backgroundSize: `${grid.big}px ${grid.big}px, ${grid.small}px ${grid.small}px`,
    backgroundPosition: `${viewport.x}px ${viewport.y}px, ${viewport.x}px ${viewport.y}px`,
  };

  const content = (
    <>
      <EdgeLayer segments={segments} nodes={nodeMap} viewport={cardViewport} selectedPair={selectedPair} focusIds={selectedIds} showDots={showDots} onSegmentPointerDown={onSegmentDown} />
      {displayNodes.map((n) => (
        <NodeCard
          key={n.id}
          node={n}
          viewport={cardViewport}
          selected={selectedIds.has(n.id)}
          editable={editable}
          previewWidth={resize?.id === n.id ? resize.w : undefined}
          onPointerDown={onNodeDown}
          onContextMenu={onNodeContextMenu}
          onResizeStart={onResizeStart}
          onActivate={onActivate}
          loadBalances={nodes.length <= 60}
        />
      ))}
    </>
  );

  return (
    <div
      ref={rootRef}
      onPointerDown={onBackgroundDown}
      onContextMenu={(e) => {
        if (e.target === e.currentTarget) e.preventDefault();
      }}
      className={cn(
        "absolute inset-0 touch-none overflow-hidden",
        mode === "pan" ? "cursor-grabbing" : mode === "lasso" ? "cursor-crosshair" : mode === "drag" ? "cursor-grabbing" : "cursor-default",
      )}
      style={bg}
      aria-label="Trace canvas"
      role="application"
    >
      {worldMode ? (
        <div className="pointer-events-none absolute left-0 top-0 [&>*]:pointer-events-auto" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`, transformOrigin: "0 0" }}>
          {content}
        </div>
      ) : (
        content
      )}
      {lasso ? <div className="pointer-events-none absolute rounded-[3px] border border-dashed border-accent bg-accent-soft" style={{ left: lasso.x, top: lasso.y, width: lasso.w, height: lasso.h }} /> : null}
      {children}
    </div>
  );
}
