import type { TraceNode } from "@osstrace/contract";
import { Layers } from "lucide-react";
import { memo, useId, useMemo, type PointerEvent as RPointerEvent } from "react";
import { formatUsd } from "../../kit/format.ts";
import { flowDots, segmentGeometry, type EdgeGeometry, type Segment } from "../lib/edges.ts";
import type { Viewport } from "../lib/viewport.ts";

type Props = {
  segments: Segment[];
  nodes: Map<string, TraceNode>;
  viewport: Viewport;
  selectedPair: string | null;
  /** Selected node ids: edges touching them are emphasised and their flow dots inked by direction. */
  focusIds?: Set<string>;
  showDots: boolean;
  onSegmentPointerDown: (e: RPointerEvent, seg: Segment) => void;
};

const NO_FOCUS = new Set<string>();

function tooltip(seg: Segment) {
  const s = seg.summary;
  const usd = `${formatUsd(s.totalUSD)}${s.usdIncomplete ? " (some transfers unpriced)" : ""}`;
  if (seg.variant === "aggregate-edge") return `${usd} total / ${s.transferCount} transfers / Aggregate edge`;
  return `${usd} total / ${s.transferCount} transfers${s.tokens.length ? ` / Tokens: ${s.tokens.join(", ")}` : ""}${s.chains.length ? ` / Chains: ${s.chains.join(", ")}` : ""}`;
}

/** Which ink a forward dot (fromNodeID -> toNodeID) carries, seen from the focused node(s). */
function forwardInk(seg: Segment, focus: Set<string>): "out" | "in" | null {
  const a = focus.has(seg.fromNodeID);
  const b = focus.has(seg.toNodeID);
  if (a === b) return null;
  return a ? "out" : "in";
}

/** One SVG for every edge (screen space, recomputed with the viewport) plus HTML badges. */
export const EdgeLayer = memo(function EdgeLayer({ segments, nodes, viewport, selectedPair, focusIds = NO_FOCUS, showDots, onSegmentPointerDown }: Props) {
  const gid = useId().replace(/:/g, "");
  const geoms = useMemo(() => segments.map((s) => [s, segmentGeometry(s, nodes, viewport)] as const).filter((x): x is readonly [Segment, EdgeGeometry] => !!x[1]), [segments, nodes, viewport]);
  // dot parameters depend on the edges only: computed once per edge change, not on every pan/zoom frame
  const dots = useMemo(() => new Map(segments.map((s) => [s.id, flowDots(s)])), [segments]);
  const focused = focusIds.size > 0;
  const fill = { neutral: `url(#${gid}-n)`, in: `url(#${gid}-i)`, out: `url(#${gid}-o)` };
  return (
    <>
      <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden>
        <defs>
          {([["n", "var(--trace-text)"], ["i", "var(--trace-in)"], ["o", "var(--trace-out)"]] as const).map(([k, c]) => (
            <radialGradient key={k} id={`${gid}-${k}`}>
              <stop offset="0%" stopColor={c} stopOpacity={1} />
              <stop offset="50%" stopColor={c} stopOpacity={0.95} />
              <stop offset="78%" stopColor={c} stopOpacity={0.25} />
              <stop offset="100%" stopColor={c} stopOpacity={0} />
            </radialGradient>
          ))}
          {/* Static flow-direction arrowheads (fromNodeID -> toNodeID) -- visible with no animation, no
              selection and no focus, so direction still reads in a plain screenshot. Two fixed variants
              (neutral / accent) rather than one dynamically-colored marker, for simplicity. */}
          {([["arrow-n", "var(--traceg-edge)", 0.7], ["arrow-a", "var(--trace-accent)", 0.95]] as const).map(([k, c, o]) => (
            <marker key={k} id={`${gid}-${k}`} viewBox="0 0 8 8" refX="6.4" refY="4" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse" markerUnits="strokeWidth">
              <path d="M0.5,0.8 L7,4 L0.5,7.2 Z" fill={c} fillOpacity={o} />
            </marker>
          ))}
        </defs>
        {geoms.map(([seg, g]) => {
          const selected = selectedPair === seg.id;
          const touches = focusIds.has(seg.fromNodeID) || focusIds.has(seg.toNodeID);
          const dim = focused && !touches && !selected;
          const fwd = selected ? null : forwardInk(seg, focusIds);
          return (
            <g key={seg.id} className="pointer-events-auto">
              {selected ? <path d={g.d} fill="none" stroke="var(--trace-accent)" strokeOpacity={0.18} strokeWidth={6} strokeLinecap="round" vectorEffect="non-scaling-stroke" /> : null}
              <path
                id={seg.pathID}
                d={g.d}
                fill="none"
                stroke={selected ? "var(--trace-accent)" : "var(--traceg-edge)"}
                strokeOpacity={selected ? 0.95 : dim ? 0.2 : touches ? 0.85 : 0.55}
                strokeWidth={selected ? 1.75 : touches ? 1.5 : 1.2}
                vectorEffect="non-scaling-stroke"
                markerEnd={dim ? undefined : `url(#${gid}-${selected ? "arrow-a" : "arrow-n"})`}
              />
              {showDots
                ? dots.get(seg.id)?.map((dot) => {
                    const ink = fwd == null ? "neutral" : dot.reverse ? (fwd === "out" ? "in" : "out") : fwd;
                    return (
                      <circle key={dot.key} r={dot.r} fill={fill[ink]} opacity={dim ? dot.opacity * 0.35 : selected ? Math.min(0.96, dot.opacity + 0.05) : dot.opacity}>
                        <animateMotion dur={`${dot.dur}s`} begin={`${dot.begin}s`} repeatCount="indefinite" calcMode="linear" {...(dot.reverse ? { keyPoints: "1;0", keyTimes: "0;1" } : {})}>
                          <mpath href={`#${seg.pathID}`} />
                        </animateMotion>
                      </circle>
                    );
                  })
                : null}
              <path d={g.d} fill="none" stroke="transparent" strokeWidth={18} vectorEffect="non-scaling-stroke" onPointerDown={(e) => onSegmentPointerDown(e, seg)} style={{ cursor: "pointer" }}>
                <title>{tooltip(seg)}</title>
              </path>
            </g>
          );
        })}
      </svg>
      {geoms.map(([seg, g]) => (
        <EdgeBadge
          key={seg.id}
          seg={seg}
          x={g.midpoint.x}
          y={g.midpoint.y}
          scale={viewport.scale}
          selected={selectedPair === seg.id}
          dim={focused && selectedPair !== seg.id && !focusIds.has(seg.fromNodeID) && !focusIds.has(seg.toNodeID)}
          onPointerDown={onSegmentPointerDown}
        />
      ))}
    </>
  );
});

/** Badges stay legible when zoomed out and do not balloon when zoomed in. */
const badgeScale = (s: number) => Math.min(1.15, Math.max(0.74, s));

const EdgeBadge = memo(function EdgeBadge({ seg, x, y, scale, selected, dim, onPointerDown }: { seg: Segment; x: number; y: number; scale: number; selected: boolean; dim: boolean; onPointerDown: Props["onSegmentPointerDown"] }) {
  const s = seg.summary;
  const agg = seg.variant === "aggregate-edge";
  const token = !agg && s.tokens.length === 1 ? s.tokens[0]!.toUpperCase().slice(0, 10) : !agg && s.tokens.length > 1 ? `${s.tokens.length} tokens` : null;
  return (
    <div
      onPointerDown={(e) => onPointerDown(e, seg)}
      title={tooltip(seg)}
      data-selected={selected}
      data-dim={dim}
      className="kit-edge-badge absolute left-0 top-0 flex h-[26px] cursor-pointer select-none items-center whitespace-nowrap rounded-[5px] text-[12px] leading-none"
      style={{ transform: `translate(${x}px, ${y}px) scale(${badgeScale(scale)}) translate(-50%, -50%)`, transformOrigin: "0 0" }}
    >
      {agg ? (
        <span className="flex h-full items-center border-r border-border px-1.5 text-muted" title="Aggregate edge">
          <Layers aria-label="Aggregate" className="size-3" />
        </span>
      ) : null}
      <span className="kit-num px-2 font-semibold">
        {formatUsd(s.totalUSD)}
        {s.usdIncomplete ? <span className="text-faint" title="Some transfers have no USD price">+</span> : null}
      </span>
      <span className="kit-num flex h-full items-center border-l border-border px-1.5 text-[11px] text-muted">{s.transferCount.toLocaleString("en-US")} tx</span>
      {token ? <span className="kit-mono flex h-full items-center border-l border-border px-1.5 text-[11px] tracking-[0.02em] text-faint">{token}</span> : null}
    </div>
  );
});
