import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChainId } from "@opentrace/core";
import { forceLayout, type Point } from "./layout.ts";

const VISUALIZER_URL = import.meta.env["VITE_VISUALIZER_URL"] ?? "http://localhost:5302";

// --- The Visualizer API's response shape (see packages/features/visualizer/README.md) ---------
interface Source {
  description: string;
  url: string;
  addedAt: string;
}
interface Label {
  name: string;
  confidence: "verified" | "predicted";
  source: Source;
}
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
  valueNative: string;
  timestamp: string;
}
interface OmittedTransaction {
  hash: string;
  timestamp: string;
  direction: "in" | "out" | "self";
  valueNative: string;
  reason: "self-transfer" | "no-counterparty" | "counterparty-unresolved";
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
      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-2 sm:flex-row">
        <select
          value={chain}
          onChange={(e) => setChain(e.target.value as ChainId)}
          className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        >
          <option value="ethereum">Ethereum</option>
          <option value="solana">Solana</option>
        </select>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder={chain === "ethereum" ? "0x..." : "a Solana address"}
          className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        />
        <select
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          aria-label="How many recent transactions to graph"
          className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        >
          {[5, 10, 25, 50].map((n) => (
            <option key={n} value={n}>
              last {n} txs
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={state.status === "loading"}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
        >
          {state.status === "loading" ? "Building graph..." : "Graph it"}
        </button>
      </form>
      <p className="mt-2 text-xs text-neutral-500">
        One hop: the address and the counterparties in its most recent transactions. Click a counterparty, then “Graph this
        address” to step outward one real query at a time.
      </p>

      {state.status === "error" && (
        <div className="mt-6 rounded-md border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-300">{state.message}</div>
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
    <div className="mt-6 space-y-4">
      {!report.transactions.available ? (
        <div className="rounded-md border border-amber-800 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
          Transaction history unavailable — {report.transactions.reason}. Only the address itself (and anything on record about it) is
          shown; no counterparties are drawn because none were fetched.
        </div>
      ) : (
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-neutral-400">
          <span>
            <span className="text-neutral-100">{report.nodes.length - 1}</span> counterparties
          </span>
          <span>
            <span className="text-neutral-100">{report.edges.length}</span> transfers drawn
          </span>
          <span>
            <span className="text-neutral-100">{report.transactions.fetched}</span> recent transactions fetched
          </span>
          {report.omitted.length > 0 && (
            <span>
              <span className="text-neutral-100">{report.omitted.length}</span> not drawn (see below)
            </span>
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <GraphCanvas report={report} selectedId={selected?.id ?? null} onSelect={setSelectedId} />
        {selected && <NodePanel node={selected} report={report} onRecenter={onRecenter} />}
      </div>

      {report.omitted.length > 0 && (
        <details className="rounded-md border border-neutral-800 bg-neutral-900 px-4 py-3 text-sm">
          <summary className="cursor-pointer text-neutral-300">
            {report.omitted.length} fetched transaction{report.omitted.length === 1 ? "" : "s"} not drawn as edges
          </summary>
          <ul className="mt-2 space-y-1 text-xs text-neutral-400">
            {[...omittedByReason.entries()].map(([reason, count]) => (
              <li key={reason}>
                {count} × {OMISSION_TEXT[reason]}
              </li>
            ))}
          </ul>
          <ul className="mt-3 divide-y divide-neutral-800 text-xs">
            {report.omitted.map((o) => (
              <li key={`${o.hash}:${o.reason}`} className="flex items-center justify-between gap-3 py-1.5">
                <a href={TX_URL[report.center.chain](o.hash)} target="_blank" rel="noreferrer" className="truncate font-mono text-neutral-400 hover:text-neutral-200">
                  {o.hash}
                </a>
                <span className="shrink-0 text-neutral-500">{o.reason}</span>
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
    <div className="relative overflow-hidden rounded-md border border-neutral-800 bg-neutral-900">
      <div ref={containerRef} className="h-[420px] w-full sm:h-[560px]">
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
            className="h-8 w-8 rounded-md border border-neutral-700 bg-neutral-950/90 text-sm text-neutral-200 hover:bg-neutral-800"
          >
            {b.label}
          </button>
        ))}
      </div>

      <div className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap gap-x-3 gap-y-1 rounded bg-neutral-950/85 px-2 py-1 text-[11px] text-neutral-400">
        <span className="text-emerald-400">→ into the address</span>
        <span className="text-orange-400">→ out of it</span>
        <span className="text-amber-300">● labeled</span>
        <span className="text-red-400">● sanctioned</span>
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
    <aside className="space-y-3 rounded-md border border-neutral-800 bg-neutral-900 px-4 py-3 text-sm lg:max-h-[560px] lg:overflow-y-auto">
      <div>
        <div className="text-xs uppercase tracking-wide text-neutral-500">{node.role === "center" ? "Queried address" : "Counterparty"}</div>
        <div className="mt-1 break-all font-mono text-xs text-neutral-200">{node.id}</div>
      </div>

      {node.label ? (
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{node.label.name}</span>
            <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">{node.label.confidence}</span>
          </div>
          <a href={node.label.source.url} target="_blank" rel="noreferrer" className="mt-1 block text-xs text-neutral-500 hover:text-neutral-300">
            Source: {node.label.source.description} · added {node.label.source.addedAt}
          </a>
        </div>
      ) : (
        <div className="text-xs text-neutral-500">No label on record.</div>
      )}

      {node.entity && <div className="text-xs text-neutral-300">Entity: {node.entity.name}</div>}

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
                  ? "rounded bg-red-900 px-2 py-0.5 text-xs font-medium text-red-200"
                  : "rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300"
              }
            >
              {t.tag === "sanctioned" ? "SANCTIONED" : t.tag}
            </a>
          ))}
        </div>
      )}

      <dl className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <dt className="text-neutral-500">Received ({node.stats.inCount})</dt>
          <dd className="break-all text-emerald-400">
            {node.stats.totalIn} {symbol}
          </dd>
        </div>
        <div>
          <dt className="text-neutral-500">Sent ({node.stats.outCount})</dt>
          <dd className="break-all text-orange-400">
            {node.stats.totalOut} {symbol}
          </dd>
        </div>
      </dl>
      <p className="text-[11px] text-neutral-500">
        Totals cover only the transfers in this graph{node.role === "counterparty" ? " (with the queried address)" : ""}, not full history.
      </p>

      {node.role === "counterparty" && (
        <button
          type="button"
          onClick={() => onRecenter(node)}
          className="w-full rounded-md border border-emerald-700 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-950"
        >
          Graph this address
        </button>
      )}

      {edges.length > 0 && (
        <div>
          <div className="text-xs uppercase tracking-wide text-neutral-500">Transfers</div>
          <ul className="mt-1 divide-y divide-neutral-800">
            {edges.map((e) => {
              // Direction from this node's point of view.
              const incoming = e.target === node.id;
              return (
                <li key={e.id} className="py-1.5">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <a href={txUrl(e.hash)} target="_blank" rel="noreferrer" className="truncate font-mono text-neutral-400 hover:text-neutral-200">
                      {short(e.hash)}
                    </a>
                    <span className={incoming ? "shrink-0 text-emerald-400" : "shrink-0 text-orange-400"}>
                      {incoming ? "+" : "-"}
                      {e.valueNative} {symbol}
                    </span>
                  </div>
                  <div className="text-[11px] text-neutral-500">
                    {incoming ? "from" : "to"} {short(incoming ? e.source : e.target)} · {new Date(e.timestamp).toLocaleString()}
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
