/** Free canvas area: the rectangle left after the floating panels, and fitting a world box into it.
 *  Used by the tracer (own viewport) and the visualizer (force-graph centerAt/zoom). Pure, unit tested. */

export type Insets = { left?: number; right?: number; top?: number; bottom?: number };
export type Area = { x: number; y: number; w: number; h: number };
export type Box = { x: number; y: number; w: number; h: number };

/** Smallest free width/height worth fitting into; below it the panels are ignored (left first, then right). */
export const MIN_FREE = 240;
export const FIT_MARGIN = 0.12;

export function freeArea(W: number, H: number, insets: Insets = {}, min = MIN_FREE): Area {
  let l = Math.max(0, insets.left ?? 0);
  let r = Math.max(0, insets.right ?? 0);
  let t = Math.max(0, insets.top ?? 0);
  let b = Math.max(0, insets.bottom ?? 0);
  if (W - l - r < min) l = 0;
  if (W - l - r < min) r = 0;
  if (H - t - b < min) {
    t = 0;
    b = 0;
  }
  return { x: l, y: t, w: Math.max(0, W - l - r), h: Math.max(0, H - t - b) };
}

/** Bounding box of points, grown by `pad` world units on every side. Null when there are no finite points. */
export function pointsBox(points: Iterable<{ x?: number; y?: number }>, pad = 0): Box | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    if (p.x == null || p.y == null || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  if (x0 === Infinity) return null;
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
}

/** Scale that fits `box` inside `area` leaving `margin` (fraction of the area) on each side, clamped. */
export function fitScale(box: Box, area: Area, opts: { margin?: number; min?: number; max?: number } = {}): number {
  const m = opts.margin ?? FIT_MARGIN;
  const bw = Math.max(box.w, 1);
  const bh = Math.max(box.h, 1);
  const s = Math.min((area.w * (1 - 2 * m)) / bw, (area.h * (1 - 2 * m)) / bh);
  return Math.min(opts.max ?? Infinity, Math.max(opts.min ?? 0, s));
}

/** Screen-space transform (x, y = screen position of world origin) putting the box centre at the area centre. */
export function fitTransform(box: Box, area: Area, opts: { margin?: number; min?: number; max?: number } = {}): { x: number; y: number; scale: number } {
  const scale = fitScale(box, area, opts);
  const cx = area.x + area.w / 2;
  const cy = area.y + area.h / 2;
  return { scale, x: cx - (box.x + box.w / 2) * scale, y: cy - (box.y + box.h / 2) * scale };
}

/** For a canvas whose camera is "world point at the canvas centre + zoom" (force-graph centerAt/zoom):
 *  the world point to centre on so that the box centre lands at the free area's centre. */
export function centerForArea(box: Box, area: Area, W: number, H: number, opts: { margin?: number; min?: number; max?: number } = {}): { cx: number; cy: number; k: number } {
  const k = fitScale(box, area, opts);
  const ax = area.x + area.w / 2;
  const ay = area.y + area.h / 2;
  return { k, cx: box.x + box.w / 2 - (ax - W / 2) / k, cy: box.y + box.h / 2 - (ay - H / 2) / k };
}
