/** Tracer viewport math. Viewport = screen offset of world origin + scale. */
import type { TraceNode, XY } from "@osstrace/contract";

export const NODE_WIDTH = 254;
export const NODE_HEIGHT = 72;
export const GRID_SPACING = 24;
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 10;
export const FIT_PADDING = 0.12;

export type Viewport = { x: number; y: number; scale: number };
export type Rect = { x: number; y: number; w: number; h: number };

export const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

export const worldToScreen = (p: XY, v: Viewport): XY => ({ x: v.x + p.x * v.scale, y: v.y + p.y * v.scale });
export const screenToWorld = (p: XY, v: Viewport): XY => ({ x: (p.x - v.x) / v.scale, y: (p.y - v.y) / v.scale });
export const clientToWorld = (cx: number, cy: number, rect: { left: number; top: number }, v: Viewport): XY =>
  screenToWorld({ x: cx - rect.left, y: cy - rect.top }, v);

/** Zoom to `scale`, keeping the screen point `anchor` (canvas-relative px) over the same world point. */
export function zoomAt(v: Viewport, nextScale: number, anchor: XY): Viewport {
  const s = clampScale(nextScale);
  const wx = (anchor.x - v.x) / v.scale;
  const wy = (anchor.y - v.y) / v.scale;
  return { x: anchor.x - wx * s, y: anchor.y - wy * s, scale: s };
}

/** Wheel factor: 2^(-deltaY * k), k by deltaMode; ctrl (trackpad pinch) is 10x more sensitive. */
export function wheelFactor(deltaY: number, deltaMode: number, ctrlKey: boolean): number {
  const k = deltaMode === 1 ? 0.05 : deltaMode === 2 ? 1 : 0.002;
  return Math.pow(2, -deltaY * k * (ctrlKey ? 10 : 1));
}

export const nodeSize = (n: Pick<TraceNode, "width" | "height">) => {
  if (n.width && n.width > 0) {
    const w = n.width;
    return { w, h: n.height && n.height > 0 ? n.height : (w * NODE_HEIGHT) / NODE_WIDTH };
  }
  return { w: NODE_WIDTH, h: NODE_HEIGHT };
};

export const nodeRect = (n: TraceNode): Rect => {
  const { w, h } = nodeSize(n);
  return { x: n.currentPosition.x, y: n.currentPosition.y, w, h };
};

export const nodeCenter = (n: TraceNode): XY => {
  const r = nodeRect(n);
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
};

export function boundingBox(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Fit rects into W x H with 12 % padding; never zooms in past 1. */
export function fitViewport(rects: Rect[], W: number, H: number, insets: { left?: number; right?: number } = {}): Viewport | null {
  const bb = boundingBox(rects);
  let l = insets.left ?? 0;
  const r = insets.right ?? 0;
  // overlays that leave too little room: first ignore the left panel, then both
  if (W - l - r < 240) l = 0;
  const useInsets = W - l - r >= 240;
  const w = useInsets ? W - l - r : W;
  if (!bb || w <= 0 || H <= 0) return null;
  const bw = Math.max(bb.w, 1);
  const bh = Math.max(bb.h, 1);
  const scale = clampScale(Math.min((w * (1 - 2 * FIT_PADDING)) / bw, (H * (1 - 2 * FIT_PADDING)) / bh, 1));
  const v = centerOn(bb, w, H, scale);
  return useInsets ? { ...v, x: v.x + l } : v;
}

export function centerOn(bb: Rect, W: number, H: number, scale: number): Viewport {
  return { x: W / 2 - (bb.x + bb.w / 2) * scale, y: H / 2 - (bb.y + bb.h / 2) * scale, scale };
}

export function screenRectOfNode(n: TraceNode, v: Viewport): Rect {
  const r = nodeRect(n);
  const p = worldToScreen(r, v);
  return { x: p.x, y: p.y, w: r.w * v.scale, h: r.h * v.scale };
}

export const rectsIntersect = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Normalise a drag rectangle given two corner points. */
export const rectFromPoints = (a: XY, b: XY): Rect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

/** Dot grid that crossfades between two densities as the zoom passes powers of two. */
export function gridLayers(scale: number) {
  const n = GRID_SPACING * Math.pow(2, Math.ceil(-Math.log2(scale)));
  const l = Math.log2(scale);
  const frac = l - Math.floor(l);
  const f = Math.min(1, Math.max(0, (frac - 0.41) / 0.18));
  return { big: n * scale, small: (n / 2) * scale, opacityBig: 0.6 * (1 - f), opacitySmall: 0.6 * f };
}

/** Aspect-locked resize: project the pointer delta (world units) onto the card diagonal. */
export function resizeWidth(startW: number, startH: number, dx: number, dy: number): number {
  const w = startW * (1 + (dx * startW + dy * startH) / (startW * startW + startH * startH));
  return Math.min(800, Math.max(60, w));
}

// ---------- viewport persistence (bounded LRU in localStorage) ----------
const VIEWPORT_KEY = "osstrace_tracer_viewports";
const MAX_ENTRIES = 50;
type Stored = Record<string, { viewport: Viewport; savedAt: number }>;

function readAll(key: string): Stored {
  try {
    const raw = localStorage.getItem(key);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === "object" ? (v as Stored) : {};
  } catch {
    return {};
  }
}

export function loadViewport(id: string, key = VIEWPORT_KEY): Viewport | null {
  const e = readAll(key)[id];
  const v = e?.viewport;
  if (!v || ![v.x, v.y, v.scale].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return { x: v.x, y: v.y, scale: clampScale(v.scale) };
}

export function saveViewport(id: string, viewport: Viewport, key = VIEWPORT_KEY, now = Date.now()) {
  const all = readAll(key);
  all[id] = { viewport, savedAt: now };
  const entries = Object.entries(all).sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, MAX_ENTRIES);
  try {
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* storage full or blocked: viewport just isn't remembered */
  }
}
