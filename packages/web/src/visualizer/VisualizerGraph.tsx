import { forceX, forceY } from "d3-force";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import { formatUsd } from "../kit/format.ts";
import { linkSide, linkWidth, type GraphLink, type GraphNode } from "./lib/graph.ts";
import { pictureFor, type Palette } from "./picture.ts";

export type GraphHandle = ForceGraphMethods<GraphNode, GraphLink> | undefined;

type Props = {
  nodes: GraphNode[];
  links: GraphLink[];
  width: number;
  height: number;
  palette: Palette;
  isHidden: Record<string, boolean>;
  editable: boolean;
  cursor: string;
  selectedLinkId: string | null;
  onNodeClick: (n: GraphNode, e: MouseEvent) => void;
  onNodeRightClick: (n: GraphNode, e: MouseEvent) => void;
  onLinkClick: (l: GraphLink) => void;
  onBackgroundClick: () => void;
  onNodeDragEnd: (n: GraphNode) => void;
  onZoom: (t: { k: number; x: number; y: number }) => void;
  onEngineStop: () => void;
  onReady: () => void;
};

/** Labels: always for base and hovered nodes, for everyone once zoomed in this far. */
const LABEL_ALL_K = 3;
const labelText = (n: GraphNode) => (n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label);
/** ctx.font strings per size bucket, so the frame loop never builds strings. */
const fontCache = new Map<string, string>();
function labelFont(sizeUnits: number, weight: number, family: string) {
  const b = Math.round(sizeUnits * 10) / 10;
  const key = `${weight}|${b}|${family}`;
  let f = fontCache.get(key);
  if (!f) {
    f = `${weight} ${b}px ${family}`;
    fontCache.set(key, f);
  }
  return f;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const endNode = (e: string | GraphNode) => (typeof e === "string" ? null : e);

/** ForceGraph2D with the custom forces and picture-cached node drawing. */
export const VisualizerGraph = memo(
  forwardRef<GraphHandle, Props>(function VisualizerGraph(p, ref) {
    const fg = useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(undefined);
    useImperativeHandle(ref, () => fg.current, [fg.current]); // eslint-disable-line react-hooks/exhaustive-deps
    const graphData = useMemo(() => ({ nodes: p.nodes, links: p.links }), [p.nodes, p.links]);

    // pre-render pictures and label strings outside the frame loop: the canvas callbacks only blit and fillText
    useMemo(() => {
      for (const n of p.nodes) {
        const x = n as GraphNode & { pic?: HTMLCanvasElement; lbl?: string };
        x.pic = pictureFor(n, p.palette);
        x.lbl = labelText(n);
      }
    }, [p.nodes, p.palette]);

    // hover focus: the hovered node, its neighbours and their links stay lit, the rest dims
    const [hoverId, setHoverId] = useState<string | null>(null);
    const near = useMemo(() => {
      if (!hoverId) return null;
      const ids = new Set<string>([hoverId]);
      const links = new Set<string>();
      for (const l of p.links) {
        const s = typeof l.source === "string" ? l.source : l.source.id;
        const t = typeof l.target === "string" ? l.target : l.target.id;
        if (s === hoverId || t === hoverId) {
          ids.add(s);
          ids.add(t);
          links.add(l.id);
        }
      }
      return { ids, links };
    }, [hoverId, p.links]);
    const nearRef = useRef(near);
    nearRef.current = near;
    useEffect(() => {
      if (hoverId && !p.nodes.some((n) => n.id === hoverId)) setHoverId(null);
    }, [p.nodes, hoverId]);
    const hiddenRef = useRef(p.isHidden);
    hiddenRef.current = p.isHidden;
    const nodesRef = useRef(p.nodes);
    nodesRef.current = p.nodes;

    const drawLabels = useCallback(
      (ctx: CanvasRenderingContext2D, k: number) => {
        const pal = p.palette;
        const nr = nearRef.current;
        const all = k >= LABEL_ALL_K;
        // ~11px on screen, clamped so labels neither vanish nor swamp the graph
        const size = Math.min(3.4, Math.max(1.5, 11 / k));
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.lineJoin = "round";
        ctx.lineWidth = size * 0.32;
        ctx.strokeStyle = pal.bg;
        const hidden = hiddenRef.current;
        for (const n of nodesRef.current) {
          if (n.x == null || n.y == null) continue;
          if (!n.isBase && hidden[n.group]) continue;
          const lit = nr ? nr.ids.has(n.id) : false;
          if (!(all || n.isBase || lit)) continue;
          if (nr && !lit && !n.isBase) continue;
          const lbl = (n as GraphNode & { lbl?: string }).lbl;
          if (!lbl) continue;
          const strong = n.isBase || n.id === hoverId;
          ctx.font = labelFont(size, strong ? 600 : 400, n.kind === "entity" || n.info?.label || n.info?.entity ? pal.sans : pal.mono);
          const y = n.y + (n.isBase ? 6.4 : 5.6);
          ctx.strokeText(lbl, n.x, y);
          ctx.fillStyle = strong ? pal.text : pal.muted;
          ctx.fillText(lbl, n.x, y);
        }
      },
      [p.palette, hoverId],
    );

    // custom forces: base nodes pulled to the origin, senders drift left, receivers drift right
    useEffect(() => {
      const g = fg.current;
      if (!g) return;
      const share = (n: GraphNode, side: "in" | "out") => {
        const tot = n.inflow + n.outflow;
        if (n.isBase || tot === 0) return 0;
        if (side === "out") return n.outflow >= n.inflow ? (0.06 * n.outflow) / tot : 0;
        return n.inflow >= n.outflow ? (0.06 * n.inflow) / tot : 0;
      };
      g.d3Force("center", null);
      g.d3Force("centerX", forceX<GraphNode>(0).strength((n) => (n.isBase ? 0.5 : 0)) as never);
      g.d3Force("centerY", forceY<GraphNode>(0).strength((n) => (n.isBase ? 0.5 : 0)) as never);
      g.d3Force("inflowLeft", forceX<GraphNode>(-500).strength((n) => share(n, "out")) as never);
      g.d3Force("outflowRight", forceX<GraphNode>(500).strength((n) => share(n, "in")) as never);
      g.d3ReheatSimulation();
    }, [p.nodes, p.width > 0]); // eslint-disable-line react-hooks/exhaustive-deps

    const readyOnce = useRef(false);
    useEffect(() => {
      if (readyOnce.current || p.width === 0) return;
      let frames = 0;
      const tick = () => {
        if (fg.current) {
          readyOnce.current = true;
          p.onReady();
        } else if (frames++ < 60) requestAnimationFrame(tick);
      };
      tick();
    }, [p.width]); // eslint-disable-line react-hooks/exhaustive-deps

    const pal = p.palette;
    return (
      <div style={{ cursor: p.cursor }} className="absolute inset-0">
        <ForceGraph2D<GraphNode, GraphLink>
          ref={fg}
          width={p.width}
          height={p.height}
          graphData={graphData}
          backgroundColor="transparent"
          cooldownTicks={100}
          nodeRelSize={5}
          enableNodeDrag
          linkCurvature="curvature"
          nodeId="id"
          nodeCanvasObject={(n, ctx) => {
            const pic = (n as GraphNode & { pic?: HTMLCanvasElement }).pic;
            const dim = near !== null && !near.ids.has(n.id);
            if (dim) ctx.globalAlpha = 0.3;
            if (pic) ctx.drawImage(pic, (n.x ?? 0) - 5, (n.y ?? 0) - 5, 10, 10);
            else {
              ctx.beginPath();
              ctx.arc(n.x ?? 0, n.y ?? 0, 5, 0, 2 * Math.PI);
              ctx.fillStyle = pal.disc;
              ctx.fill();
            }
            if (dim) ctx.globalAlpha = 1;
          }}
          onRenderFramePost={drawLabels}
          onNodeHover={(n) => setHoverId(n ? n.id : null)}
          nodeLabel={(n) =>
            `<div style="font:12px/1.4 ${pal.sans};padding:6px 8px;background:${pal.surface};color:${pal.text};border:1px solid ${pal.border};border-radius:6px"><div style="font-weight:600">${esc(n.label)}</div><div style="font:11px ${pal.mono};color:${pal.muted}">${esc(
              n.kind === "entity" ? `${n.addresses.size} address${n.addresses.size === 1 ? "" : "es"}` : n.address ? `${n.chain === "solana" ? "SOL" : "ETH"} · ${n.address.slice(0, 8)}…${n.address.slice(-6)}` : "",
            )}</div></div>`
          }
          nodeVisibility={(n) => n.isBase || !p.isHidden[n.group]}
          linkVisibility={(l) => {
            const s = endNode(l.source);
            const t = endNode(l.target);
            return !!s && !!t && (s.isBase || !p.isHidden[s.group]) && (t.isBase || !p.isHidden[t.group]);
          }}
          linkColor={(l) => {
            if (l.id === p.selectedLinkId) return pal.accent;
            const s = endNode(l.source);
            const t = endNode(l.target);
            if (!s || !t) return pal.neutral;
            const side = linkSide(s, t);
            const dim = near !== null && !near.links.has(l.id);
            if (side === "in") return dim ? pal.inDim : pal.in;
            if (side === "out") return dim ? pal.outDim : pal.out;
            return dim ? pal.neutralDim : pal.neutral;
          }}
          linkWidth={(l) => (l.id === p.selectedLinkId ? linkWidth(l.usd) + 0.75 : near?.links.has(l.id) ? linkWidth(l.usd) + 0.35 : linkWidth(l.usd))}
          linkLabel={(l) => esc(l.usd == null ? "No USD price" : formatUsd(l.usd))}
          onNodeClick={(n, e) => p.onNodeClick(n, e)}
          onNodeRightClick={(n, e) => p.onNodeRightClick(n, e)}
          onBackgroundRightClick={() => p.onBackgroundClick()}
          onLinkClick={(l) => p.onLinkClick(l)}
          onBackgroundClick={() => p.onBackgroundClick()}
          onNodeDragEnd={(n) => p.onNodeDragEnd(n)}
          onEngineStop={p.onEngineStop}
          onZoom={p.onZoom}
        />
      </div>
    );
  }),
);
