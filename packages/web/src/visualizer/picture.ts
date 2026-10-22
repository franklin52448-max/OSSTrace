/** Offscreen node pictures, cached LRU per variant. No third-party logos: initials / hash discs only. */
import { TYPE_GROUPS, type GraphNode } from "./lib/graph.ts";

export type Palette = {
  theme: string;
  disc: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  in: string;
  out: string;
  neutral: string;
  /** dimmed link inks while another node is hovered */
  inDim: string;
  outDim: string;
  neutralDim: string;
  faint: string;
  bg: string;
  sans: string;
  mono: string;
  vars: Record<string, string>;
};

const VAR_NAMES = ["--trace-node-red", "--trace-node-amber", "--trace-node-purple", "--trace-node-green", "--trace-node-blue", "--trace-node-gray"];

/** Read the token values once per theme (canvas needs concrete colours). */
export function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, fb: string) => cs.getPropertyValue(n).trim() || fb;
  const vars: Record<string, string> = {};
  for (const n of VAR_NAMES) vars[n] = v(n, "#999");
  const muted = v("--trace-text-muted", "#a3a29d");
  return {
    theme: document.documentElement.dataset.theme ?? "dark",
    disc: v("--trace-surface-2", "#202124"),
    surface: v("--trace-surface", "#18191b"),
    text: v("--trace-text", "#e7e6e3"),
    muted,
    border: v("--trace-border-strong", "#3d4046"),
    accent: v("--trace-accent", "#86a8f0"),
    in: v("--trace-in", "#7cc597"),
    out: v("--trace-out", "#e2a35c"),
    neutral: withAlpha(muted, 0.5),
    inDim: withAlpha(v("--trace-in", "#7cc597"), 0.12),
    outDim: withAlpha(v("--trace-out", "#e2a35c"), 0.12),
    neutralDim: withAlpha(muted, 0.1),
    faint: v("--trace-text-faint", "#8a8983"),
    bg: v("--trace-bg", "#121314"),
    sans: v("--trace-font-sans", "system-ui"),
    mono: v("--trace-font-mono", "monospace"),
    vars,
  };
}

function withAlpha(color: string, a: number) {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const SIZE = typeof window !== "undefined" && window.innerWidth < 768 ? 256 : 384;
const MAX = SIZE === 256 ? 512 : 2048;
const cache = new Map<string, HTMLCanvasElement>();

/** FNV-1a over the address: 15 stable bits for the 5x3 (mirrored to 5x5) pattern. */
function hashBits(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // never blank, never solid
  const b = (h >>> 0) & 0x7fff;
  return b === 0 || b === 0x7fff ? 0x2a5a : b;
}

/** One or two initials from a name ("Binance Hot Wallet" -> "BH", "vitalik" -> "V"). */
function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 1).toUpperCase();
  return (words[0]!.slice(0, 1) + words[1]!.slice(0, 1)).toUpperCase();
}

export function pictureFor(n: GraphNode, pal: Palette): HTMLCanvasElement | undefined {
  if (typeof document === "undefined") return undefined;
  const key = `${pal.theme}|${n.id}|${n.label}|${n.group}|${n.isBase ? 1 : 0}${n.isPinned ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const c = document.createElement("canvas");
  c.width = c.height = SIZE;
  const ctx = c.getContext("2d");
  if (!ctx) return undefined;
  const r = SIZE / 2;
  const grp = TYPE_GROUPS.find((g) => g.key === n.group);
  const typeCol = grp?.color ? pal.vars[grp.color] : null;
  const R = r * 0.78;
  // 1. disc
  ctx.beginPath();
  ctx.arc(r, r, R, 0, 2 * Math.PI);
  ctx.fillStyle = pal.disc;
  ctx.fill();
  if (n.isBase) {
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = pal.accent;
    ctx.fill();
    ctx.globalAlpha = 1;
  } else if (typeCol) {
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = typeCol;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  // 2. type ring (entity type colour) or a hairline for unlabelled addresses
  ctx.beginPath();
  ctx.arc(r, r, R, 0, 2 * Math.PI);
  ctx.lineWidth = typeCol ? SIZE / 20 : SIZE / 48;
  ctx.strokeStyle = typeCol ?? pal.border;
  ctx.stroke();
  // 3. glyph: initials for named nodes; a 5x5 mirrored pattern derived from the address for unnamed ones
  //    (the readable label is drawn beside the node, so the disc only has to tell nodes apart)
  const named = n.kind === "entity" || !!n.info?.label?.name || !!n.info?.entity?.name;
  if (named) {
    const nameSrc = n.kind === "entity" ? n.label : n.info?.label?.name ?? n.info?.entity?.name ?? "";
    ctx.fillStyle = pal.text;
    ctx.font = `600 ${Math.round(SIZE * 0.3)}px ${pal.sans}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initials(nameSrc), r, r + SIZE * 0.015, R * 1.6);
  } else {
    const bits = hashBits(n.address ?? n.id);
    const cell = (R * 1.02) / 5;
    const x0 = r - cell * 2.5;
    const y0 = r - cell * 2.5;
    ctx.fillStyle = pal.muted;
    ctx.globalAlpha = 0.62;
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (!((bits >>> (row * 3 + col)) & 1)) continue;
        ctx.fillRect(x0 + col * cell, y0 + row * cell, cell * 0.86, cell * 0.86);
        if (col < 2) ctx.fillRect(x0 + (4 - col) * cell, y0 + row * cell, cell * 0.86, cell * 0.86);
      }
    }
    ctx.globalAlpha = 1;
  }
  // 4. base ring: an accent ring with a gap, outside the disc
  if (n.isBase) {
    ctx.beginPath();
    ctx.arc(r, r, r * 0.92, 0, 2 * Math.PI);
    ctx.lineWidth = SIZE / 16;
    ctx.strokeStyle = pal.accent;
    ctx.stroke();
  }
  // 5. pin lock at 225 degrees (top-left)
  if (n.isPinned) {
    const a = (5 * Math.PI) / 4;
    const cx = r + Math.cos(a) * r * 0.74;
    const cy = r + Math.sin(a) * r * 0.74;
    const s = SIZE / 9;
    ctx.beginPath();
    ctx.arc(cx, cy, s * 1.25, 0, 2 * Math.PI);
    ctx.fillStyle = pal.bg;
    ctx.fill();
    ctx.fillStyle = pal.text;
    ctx.fillRect(cx - s * 0.6, cy - s * 0.1, s * 1.2, s * 0.85);
    ctx.beginPath();
    ctx.arc(cx, cy - s * 0.1, s * 0.4, Math.PI, 2 * Math.PI);
    ctx.lineWidth = s * 0.22;
    ctx.strokeStyle = pal.text;
    ctx.stroke();
  }
  cache.set(key, c);
  if (cache.size > MAX) cache.delete(cache.keys().next().value!);
  return c;
}
