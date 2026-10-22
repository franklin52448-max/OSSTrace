/** Placement of new nodes next to a base node with a fan search. */
import type { TraceNode, XY } from "@osstrace/contract";
import { NODE_HEIGHT, NODE_WIDTH, nodeRect, rectsIntersect, type Rect } from "./viewport.ts";

export const PLACEMENT_GAP = 290;
export const FAN_STEP = 200;
export const FAN_CANDIDATES = 16;
export const PLACEMENT_PADDING = 24;
export const OFFSCREEN_COST = 17;

export type Side = "outflow" | "inflow";

export const sideFor = (countOut: number, countIn: number): Side => (countOut >= countIn ? "outflow" : "inflow");

/** y offsets 0, +200, -200, +400, -400, ... */
export function fanOffsets(n = FAN_CANDIDATES, step = FAN_STEP): number[] {
  const out = [0];
  for (let i = 1; out.length < n; i++) {
    out.push(i * step);
    if (out.length < n) out.push(-i * step);
  }
  return out;
}

const pad = (r: Rect, p: number): Rect => ({ x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p });
const inside = (r: Rect, view: Rect) => r.x >= view.x && r.y >= view.y && r.x + r.w <= view.x + view.w && r.y + r.h <= view.y + view.h;

export type PlaceArgs = {
  base: Rect;
  side: Side;
  occupied: Rect[];
  /** visible world rect, used to prefer on-screen spots */
  visible?: Rect | null;
  size?: { w: number; h: number };
};

export function placeNear({ base, side, occupied, visible, size = { w: NODE_WIDTH, h: NODE_HEIGHT } }: PlaceArgs): XY {
  const x = side === "outflow" ? base.x + base.w + PLACEMENT_GAP : base.x - size.w - PLACEMENT_GAP;
  const y0 = base.y + (base.h - size.h) / 2;
  let best: { pos: XY; cost: number } | null = null;
  let last: XY = { x, y: y0 };
  fanOffsets().forEach((dy, i) => {
    const cand: Rect = { x, y: y0 + dy, w: size.w, h: size.h };
    last = { x: cand.x, y: cand.y };
    const padded = pad(cand, PLACEMENT_PADDING);
    if (occupied.some((o) => rectsIntersect(padded, o))) return;
    const cost = i + (visible && !inside(cand, visible) ? OFFSCREEN_COST : 0);
    if (!best || cost < best.cost) best = { pos: { x: cand.x, y: cand.y }, cost };
  });
  return best ? (best as { pos: XY }).pos : last;
}

/** Place several nodes one after another, each seeing the previous ones as occupied. */
export function placeMany(args: Omit<PlaceArgs, "side"> & { sides: Side[] }): XY[] {
  const occ = [...args.occupied];
  return args.sides.map((side) => {
    const p = placeNear({ ...args, side, occupied: occ });
    occ.push({ x: p.x, y: p.y, w: args.size?.w ?? NODE_WIDTH, h: args.size?.h ?? NODE_HEIGHT });
    return p;
  });
}

export const occupiedRects = (nodes: TraceNode[]) => nodes.map(nodeRect);
