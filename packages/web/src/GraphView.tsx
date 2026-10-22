import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChainId } from "@osstrace/core";
import { forceLayout, type Point } from "./layout.ts";
import { ReviewBadge, SubmissionByline, type LabelView } from "./LabelReview.tsx";
import { formatTimestamp } from "./timeDisplay.ts";

const VISUALIZER_URL = import.meta.env["VITE_VISUALIZER_URL"] ?? "http://localhost:5302";

// --- The Visualizer API's response shape (see packages/features/visualizer/README.md) ---------
interface Source {
  description: string;
  url: string;
  addedAt: string;
}
type Label = LabelView;
interface Tag {
  tag: string;
  source: Source;
}
interface Entity {
  id: string;
  name: string;
  source: Source;
}
interface NodeStats {
  txCount: number;
  inCount: number;
  outCount: number;
  totalIn: string;
  totalOut: string;
}
interface GraphNode {
  id: string;
  address: { chain: ChainId; value: string };
  role: "center" | "counterparty";
  label: Label | null;
  tags: Tag[];
  entity: Entity | null;
  stats: NodeStats;
}
interface GraphEdge {
  id: string;
  hash: string;
  source: string;
  target: string;
  direction: "in" | "out";
  kind: "native" | "token";
  valueNative: string;
  token?: { address: string | null; symbol: string | null; amount: string | null; rawAmount: string };
  /** `null` when the chain didn't report when it happened (ADR 0016). */
  timestamp: string | null;
}
interface OmittedTransaction {
  hash: string;
  timestamp: string | null;
  direction: "in" | "out" | "self";
  valueNative: string;
  reason: "self-transfer" | "no-counterparty" | "counterparty-unresolved" | "failed";
}
interface GraphReport {
  center: { chain: ChainId; value: string };
  hops: 1;
  transactions: { available: true; fetched: number } | { available: false; reason: string };
  nodes: GraphNode[];
  edges: GraphEdge[];
  omitted: OmittedTransaction[];
}

type GraphState = { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "done"; report: GraphReport };

const SYMBOL: Record<ChainId, string> = { ethereum: "ETH", solana: "SOL" };
const TX_URL: Record<ChainId, (hash: string) => string> = {
  ethereum: (hash) => `https://etherscan.io/tx/${hash}`,
  solana: (hash) => `https://solscan.io/tx/${hash}`,
};
const OMISSION_TEXT: Record<OmittedTransaction["reason"], string> = {
  "self-transfer": "self-transfer (sent to itself)",
  "no-counterparty": "no counterparty (e.g. contract creation, or a net outflow the adapter couldn't attribute)",
  "counterparty-unresolved": "counterparty not resolved by the chain adapter (not a plain native transfer)",
  failed: "failed transaction (reverted on-chain — nothing actually moved)",
};

function short(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export default function GraphView() {
  const [chain, setChain] = useState<ChainId>("ethereum");
  const [address, setAddress] = useState("");
  const [limit, setLimit] = useState(10);
  const [state, setState] = useState<GraphState>({ status: "idle" });

  const load = useCallback(async (targetChain: ChainId, targetAddress: string, txLimit: number) => {
    const trimmed = targetAddress.trim();
    if (!trimmed) return;
    setState({ status: "loading" });
    try {
      const res = await fetch(`${VISUALIZER_URL}/graph/${targetChain}/${encodeURIComponent(trimmed)}?limit=${txLimit}`);
      const body = (await res.json()) as GraphReport | { error: string };
      if (!res.ok || "error" in body) {
        setState({ status: "error", message: "error" in body ? body.error : `HTTP ${res.status}` });
        return;
      }
      setState({ status: "done", report: body });
    } catch (cause) {
      setState({ status: "error", message: cause instanceof Error ? cause.message : String(cause) });
    }
  }, []);

  function handleSubmit(event: React.FormEvent): void {
    event.preventDefault();
    void load(chain, address, limit);
  }

  function recenter(node: GraphNode): void {
    setChain(node.address.chain);
    setAddress(node.address.value);
    void load(node.address.chain, node.address.value, limit);
  }

  return (
    <div>
      {/* Toolbar: chain / address / hop-depth controls over the graph workspace. */}
      <div className="card overflow-hidden">
        <form onSubmit={handleSubmit} className="flex flex-col gap-2 border-b border-line p-3 sm:flex-row">
          <select value={chain} onChange={(e) => setChain(e.target.value as ChainId)} aria-label="Chain" className="ctl shrink-0">
            <option value="ethereum">Ethereum</option>
            <option value="solana">Solana</option>
          </select>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={chain === "ethereum" ? "0x…" : "a Solana address"}
            aria-label="Address to graph"
            className="ctl hash min-w-0 flex-1"
          />
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            aria-label="How many recent transactions to graph"
            className="ctl shrink-0"
          >
            {[5, 10, 25, 50].map((n) => (
              <option key={n} value={n}>
                last {n} txs
              </option>
            ))}
          </select>
          <button type="submit" disabled={state.status === "loading"} className="btn-accent shrink-0">
            {state.status === "loading" ? "Building graph…" : "Graph it"}
          </button>
        </form>
        <p className="px-4 py-2.5 text-xs leading-relaxed text-ink-faint">
          One hop: the address and the counterparties in its most recent transactions. Click a counterparty, then “Graph this
          address” to step outward one real query at a time.
        </p>
      </div>

      {state.status === "error" && (
        <div role="alert" className="mt-4 rounded-card border border-danger/35 bg-danger/10 px-4 py-3 text-sm text-danger">
          {state.message}
        </div>
      )}

      {state.status === "done" && <GraphResult key={`${state.report.center.chain}:${state.report.center.value}`} report={state.report} onRecenter={recenter} />}
    </div>
  );
}

interface DrawnLink {
  key: string;
  source: string;
  target: string;
  direction: "in" | "out";
  count: number;
  curved: boolean;
}

function GraphResult({ report, onRecenter }: { report: GraphReport; onRecenter: (node: GraphNode) => void }) {
  const [selectedId, setSelectedId] = useState<string>(report.center.value);
  const nodesById = useMemo(() => new Map(report.nodes.map((n) => [n.id, n])), [report]);
  const selected = nodesById.get(selectedId) ?? report.nodes[0];

  const omittedByReason = useMemo(() => {
    const counts = new Map<OmittedTransaction["reason"], number>();
    for (const o of report.omitted) counts.set(o.reason, (counts.get(o.reason) ?? 0) + 1);
    return counts;
  }, [report]);

  return (
    <div className="mt-4 space-y-4">
      {!report.transactions.available && (
        <div className="rounded-card border border-warn/30 bg-warn/10 px-4 py-3 text-sm text-warn">
          Transaction history unavailable — {report.transactions.reason}. Only the address itself (and anything on record about it) is
          shown; no counterparties are drawn because none were fetched.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* Framed canvas: header strip carries the real fetch stats, the field below is the graph. */}
        <section className="card flex min-w-0 flex-col overflow-hidden" aria-label="Transaction graph">
          <div className="card-header">
            <h2 className="section-title">Transaction graph</h2>
            {report.transactions.available && (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-faint">
                <span>
                  <span className="num font-medium text-ink">{report.nodes.length - 1}</span> counterparties
                </span>
                <span>
                  <span className="num font-medium text-ink">{report.edges.length}</span> transfers drawn
                </span>
                <span>
                  <span className="num font-medium text-ink">{report.transactions.fetched}</span> recent transactions fetched
                </span>
                {report.omitted.length > 0 && (
                  <span>
                    <span className="num font-medium text-ink">{report.omitted.length}</span> not drawn (see below)
                  </span>
                )}
              </div>
            )}
          </div>
          <GraphCanvas report={report} selectedId={selected?.id ?? null} onSelect={setSelectedId} />
        </section>
        {selected && <NodePanel node={selected} report={report} onRecenter={onRecenter} />}
      </div>

      {report.omitted.length > 0 && (
        <details className="card px-4 py-3 text-sm">
          <summary className="cursor-pointer list-none text-ink-dim transition-colors duration-150 hover:text-ink">
            <span className="num font-medium">{report.omitted.length}</span> fetched transaction
            {report.omitted.length === 1 ? "" : "s"} not drawn as edges
          </summary>
          <ul className="mt-3 space-y-1 text-xs text-ink-faint">
            {[...omittedByReason.entries()].map(([reason, count]) => (
              <li key={reason}>
                <span className="num">{count}</span> × {OMISSION_TEXT[reason]}
              </li>
            ))}
          </ul>
          <ul className="mt-3 divide-y divide-line border-t border-line">
            {report.omitted.map((o) => (
              <li key={`${o.hash}:${o.reason}`} className="flex items-center justify-between gap-3 py-1.5">
                <a
                  href={TX_URL[report.center.chain](o.hash)}
                  target="_blank"
                  rel="noreferrer"
                  className="hash truncate text-ink-faint transition-colors duration-150 hover:text-ink"
                >
                  {o.hash}
                </a>
                <span className="shrink-0 text-ink-faint">{o.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// --- The interactive SVG graph ---------------------------------------------------------------

interface View {
  x: number;
  y: number;
  k: number;
}

type Gesture =
  | { kind: "pan"; startX: number; startY: number; view: View; moved: boolean }
  | { kind: "drag"; id: string; startX: number; startY: number; origin: Point; moved: boolean };

function nodeRadius(node: GraphNode): number {
  return node.role === "center" ? 18 : 8 + Math.min(10, Math.sqrt(node.stats.txCount) * 3);
}

function nodeColor(node: GraphNode): { fill: string; stroke: string } {
  if (node.tags.some((t) => t.tag === "sanctioned")) return { fill: "#7f1d1d", stroke: "#f87171" };
  if (node.role === "center") return { fill: "#064e3b", stroke: "#34d399" };
  if (node.label || node.entity || node.tags.length > 0) return { fill: "#78350f", stroke: "#fbbf24" };
  return { fill: "#262626", stroke: "#737373" };
}

function GraphCanvas({ report, selectedId, onSelect }: { report: GraphReport; selectedId: string | null; onSelect: (id: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 800, height: 560 });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const gesture = useRef<Gesture | null>(null);

  const links = useMemo<DrawnLink[]>(() => {
    const grouped = new Map<string, DrawnLink>();
    for (const e of report.edges) {
      const key = `${e.source}->${e.target}`;
      const existing = grouped.get(key);
      if (existing) existing.count += 1;
      else grouped.set(key, { key, source: e.source, target: e.target, direction: e.direction, count: 1, curved: false });
    }
    for (const link of grouped.values()) link.curved = grouped.has(`${link.target}->${link.source}`);
    return [...grouped.values()];
  }, [report]);

  const initialPositions = useMemo(
    () =>
      forceLayout(
        report.nodes.map((n) => ({ id: n.id, pinned: n.role === "center" })),
        links,
      ),
    [report, links],
  );
  const [positions, setPositions] = useState<Map<string, Point>>(initialPositions);
  const [view, setView] = useState<View>({ x: 400, y: 280, k: 1 });

  const fit = useCallback(() => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of positions.values()) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    if (!Number.isFinite(minX)) return;
    const pad = 70;
    const w = Math.max(maxX - minX, 1) + pad * 2;
    const h = Math.max(maxY - minY, 1) + pad * 2;
    const k = Math.min(2, size.width / w, size.height / h);
    setView({ k, x: size.width / 2 - ((minX + maxX) / 2) * k, y: size.height / 2 - ((minY + maxY) / 2) * k });
  }, [positions, size]);

  // Track the container size so the graph fills it on any screen width.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fit once on first real size measurement (and when the container is resized).
  useEffect(() => {
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fit on resize only, not on every drag
  }, [size]);

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setView((v) => {
      const k = Math.min(6, Math.max(0.15, v.k * factor));
      const ratio = k / v.k;
      return { k, x: cx - (cx - v.x) * ratio, y: cy - (cy - v.y) * ratio };
    });
  }, []);

  // Wheel zoom needs a non-passive listener so it can stop the page from scrolling.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  function onBackgroundPointerDown(event: React.PointerEvent<SVGSVGElement>): void {
    if (gesture.current) return;
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    gesture.current = { kind: "pan", startX: event.clientX, startY: event.clientY, view, moved: false };
  }

  function onNodePointerDown(event: React.PointerEvent<SVGGElement>, id: string): void {
    event.stopPropagation();
    svgRef.current?.setPointerCapture(event.pointerId);
    const origin = positions.get(id) ?? { x: 0, y: 0 };
    gesture.current = { kind: "drag", id, startX: event.clientX, startY: event.clientY, origin, moved: false };
  }

  function onPointerMove(event: React.PointerEvent<SVGSVGElement>): void {
    const g = gesture.current;
    if (!g) return;
    const dx = event.clientX - g.startX;
    const dy = event.clientY - g.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) g.moved = true;
    if (!g.moved) return;
    if (g.kind === "pan") {
      setView({ ...g.view, x: g.view.x + dx, y: g.view.y + dy });
    } else {
      const k = view.k;
      setPositions((prev) => new Map(prev).set(g.id, { x: g.origin.x + dx / k, y: g.origin.y + dy / k }));
    }
  }

  function onPointerUp(): void {
    const g = gesture.current;
    gesture.current = null;
    if (g?.kind === "drag" && !g.moved) onSelect(g.id);
  }

  const nodesById = new Map(report.nodes.map((n) => [n.id, n]));
  const focusId = hoverId ?? selectedId;

  return (
    <div className="relative">
      <div ref={containerRef} className="graph-field h-[420px] w-full sm:h-[560px]">
        <svg
          ref={svgRef}
          width={size.width}
          height={size.height}
          className="block cursor-grab touch-none select-none active:cursor-grabbing"
          onPointerDown={onBackgroundPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          role="img"
          aria-label={`Transaction graph for ${report.center.value}`}
        >
          <defs>
            {(["in", "out"] as const).map((dir) => (
              <marker key={dir} id={`arrow-${dir}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill={dir === "in" ? "#34d399" : "#fb923c"} />
              </marker>
            ))}
          </defs>
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {links.map((link) => {
              const a = positions.get(link.source);
              const b = positions.get(link.target);
              const sourceNode = nodesById.get(link.source);
              const targetNode = nodesById.get(link.target);
              if (!a || !b || !sourceNode || !targetNode) return null;
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
              const ux = dx / d;
              const uy = dy / d;
              const rs = nodeRadius(sourceNode) + 2;
              const rt = nodeRadius(targetNode) + 4;
              const x1 = a.x + ux * rs;
              const y1 = a.y + uy * rs;
              const x2 = b.x - ux * rt;
              const y2 = b.y - uy * rt;
              // Opposite-direction pairs bow away from each other so both stay visible.
              const bend = link.curved ? 0.18 * d : 0;
              const mx = (x1 + x2) / 2 - uy * bend;
              const my = (y1 + y2) / 2 + ux * bend;
              const dimmed = focusId !== null && focusId !== report.center.value && link.source !== focusId && link.target !== focusId;
              const color = link.direction === "in" ? "#34d399" : "#fb923c";
              return (
                <g key={link.key} opacity={dimmed ? 0.15 : 0.85}>
                  <path
                    d={`M${x1},${y1} Q${mx},${my} ${x2},${y2}`}
                    fill="none"
                    stroke={color}
                    strokeWidth={(1.2 + Math.log2(link.count)) / Math.sqrt(view.k)}
                    markerEnd={`url(#arrow-${link.direction})`}
                  />
                  {link.count > 1 && (
                    <text x={mx} y={my} fill={color} fontSize={10 / Math.sqrt(view.k)} textAnchor="middle" dy="-3">
                      ×{link.count}
                    </text>
                  )}
                </g>
              );
            })}
            {report.nodes.map((node) => {
              const p = positions.get(node.id);
              if (!p) return null;
              const r = nodeRadius(node);
              const { fill, stroke } = nodeColor(node);
              const isSelected = node.id === selectedId;
              const name = node.label?.name ?? node.entity?.name ?? null;
              return (
                <g
                  key={node.id}
                  transform={`translate(${p.x},${p.y})`}
                  className="cursor-pointer"
                  onPointerDown={(e) => onNodePointerDown(e, node.id)}
                  onPointerEnter={() => setHoverId(node.id)}
                  onPointerLeave={() => setHoverId(null)}
                >
                  <title>{`${name ? `${name}\n` : ""}${node.id}\n${node.stats.txCount} transfer(s)`}</title>
                  {isSelected && <circle r={r + 6} fill="none" stroke="#e5e5e5" strokeWidth={1.5} strokeDasharray="3 3" />}
                  <circle r={r} fill={fill} stroke={stroke} strokeWidth={node.role === "center" ? 3 : 2} />
                  <text y={r + 20} textAnchor="middle" fontSize={11} fill={name ? "#fde68a" : "#a3a3a3"} className="pointer-events-none">
                    {name ? (name.length > 24 ? `${name.slice(0, 23)}…` : name) : short(node.id)}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      <div className="absolute right-2 top-2 flex flex-col gap-1">
        {[
          { label: "+", title: "Zoom in", action: () => zoomAt(1.3, size.width / 2, size.height / 2) },
          { label: "−", title: "Zoom out", action: () => zoomAt(1 / 1.3, size.width / 2, size.height / 2) },
          { label: "⤢", title: "Fit to screen", action: fit },
        ].map((b) => (
          <button
            key={b.title}
            type="button"
            title={b.title}
            aria-label={b.title}
            onClick={b.action}
            className="h-8 w-8 rounded-ctl border border-line-strong bg-ground-deep/90 text-sm text-ink-dim shadow-card backdrop-blur-sm transition-colors duration-150 hover:bg-raised hover:text-ink"
          >
            {b.label}
          </button>
        ))}
      </div>

      <div className="pointer-events-none absolute bottom-0 left-0 right-0 flex flex-wrap gap-x-4 gap-y-1 border-t border-line bg-panel/90 px-3 py-1.5 text-[11px] text-ink-faint">
        <span className="text-inbound">→ into the address</span>
        <span className="text-outbound">→ out of it</span>
        <span className="text-warn">● labeled</span>
        <span className="text-danger">● sanctioned</span>
        <span>drag to pan · scroll to zoom · click a node</span>
      </div>
    </div>
  );
}

// --- Selected-node detail panel ----------------------------------------------------------------

function NodePanel({ node, report, onRecenter }: { node: GraphNode; report: GraphReport; onRecenter: (node: GraphNode) => void }) {
  const symbol = SYMBOL[node.address.chain];
  const txUrl = TX_URL[node.address.chain];
  const edges = report.edges.filter((e) => e.source === node.id || e.target === node.id);

  return (
    <aside className="card space-y-3 p-4 text-sm lg:max-h-[624px] lg:overflow-y-auto" aria-label="Selected node">
      <div>
        <div className="section-title">{node.role === "center" ? "Queried address" : "Counterparty"}</div>
        <div className="hash mt-1.5 break-all text-xs text-ink-dim">{node.id}</div>
      </div>

      {node.label ? (
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">{node.label.name}</span>
            <span className="chip border-line-strong bg-raised text-ink-dim">{node.label.confidence}</span>
            <ReviewBadge label={node.label} />
          </div>
          <a
            href={node.label.source.url}
            target="_blank"
            rel="noreferrer"
            className="mt-1 block text-xs text-ink-faint underline decoration-line-strong underline-offset-2 transition-colors duration-150 hover:text-ink-dim"
          >
            Source: {node.label.source.description} · added {node.label.source.addedAt}
          </a>
          <SubmissionByline label={node.label} />
        </div>
      ) : (
        <div className="text-xs text-ink-faint">No label on record.</div>
      )}

      {node.entity && <div className="text-xs text-ink-dim">Entity: {node.entity.name}</div>}

      {node.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {node.tags.map((t, i) => (
            <a
              key={`${t.tag}:${i}`}
              href={t.source.url}
              target="_blank"
              rel="noreferrer"
              title={t.source.description}
              className={
                t.tag === "sanctioned"
                  ? "chip border-danger/40 bg-danger/15 text-danger transition-colors duration-150 hover:bg-danger/25"
                  : "chip border-line-strong bg-raised text-ink-dim transition-colors duration-150 hover:bg-line-strong"
              }
            >
              {t.tag === "sanctioned" ? "SANCTIONED" : t.tag}
            </a>
          ))}
        </div>
      )}

      <dl className="grid grid-cols-2 gap-2 rounded-ctl border border-line bg-ground-deep/60 p-2.5 text-xs">
        <div>
          <dt className="text-ink-faint">Received ({node.stats.inCount})</dt>
          <dd className="num mt-0.5 break-all font-mono text-inbound">
            {node.stats.totalIn} {symbol}
          </dd>
        </div>
        <div>
          <dt className="text-ink-faint">Sent ({node.stats.outCount})</dt>
          <dd className="num mt-0.5 break-all font-mono text-outbound">
            {node.stats.totalOut} {symbol}
          </dd>
        </div>
      </dl>
      <p className="text-[11px] leading-relaxed text-ink-faint">
        Totals cover only the transfers in this graph{node.role === "counterparty" ? " (with the queried address)" : ""}, not full history.
      </p>

      {node.role === "counterparty" && (
        <button
          type="button"
          onClick={() => onRecenter(node)}
          className="w-full rounded-ctl border border-signal/40 bg-signal/10 px-3 py-1.5 text-xs font-medium text-signal transition-colors duration-150 hover:bg-signal/20"
        >
          Graph this address
        </button>
      )}

      {edges.length > 0 && (
        <div>
          <div className="section-title">Transfers</div>
          <ul className="mt-1 divide-y divide-line border-t border-line">
            {edges.map((e) => {
              // Direction from this node's point of view.
              const incoming = e.target === node.id;
              return (
                <li key={e.id} className="py-1.5">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <a href={txUrl(e.hash)} target="_blank" rel="noreferrer" className="hash truncate text-ink-faint transition-colors duration-150 hover:text-ink">
                      {short(e.hash)}
                    </a>
                    <span className={`num shrink-0 font-mono ${incoming ? "text-inbound" : "text-outbound"}`}>
                      {incoming ? "+" : "-"}
                      {e.kind === "token" && e.token
                        ? (e.token.amount ?? `${e.token.rawAmount} raw units`) + " " + (e.token.symbol ?? short(e.token.address ?? "unknown token"))
                        : `${e.valueNative} ${symbol}`}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-ink-faint">
                    {incoming ? "from" : "to"} {short(incoming ? e.source : e.target)} · {formatTimestamp(e.timestamp)}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </aside>
  );
}
