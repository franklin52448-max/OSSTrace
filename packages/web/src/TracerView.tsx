import { useState } from "react";
import type { ChainId } from "@osstrace/core";
import { Checkbox } from "./prism/components.tsx";
import { Loading, Notice, PageHeader } from "./ui.tsx";

const TRACER_URL = import.meta.env["VITE_TRACER_URL"] ?? "http://localhost:5303";
const ADR_URL = "https://github.com/OpenTraceIntelligence/OSSTrace/blob/main/docs/adr/";

// --- The Tracer API's response shapes (see packages/features/tracer/README.md) ----------------
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
interface TracedNode {
  id: string;
  address: { chain: ChainId; value: string };
  role: "center" | "expanded" | "frontier";
  frontierReason?: "depth-cap" | "breadth-cap" | "budget-exhausted" | "unavailable";
  label: Label | null;
  tags: Tag[];
}
interface ChainEdge {
  id: string;
  hash: string;
  source: string;
  target: string;
  direction: "in" | "out";
  kind: "native" | "token";
  valueNative: string;
  token?: { address: string | null; symbol: string | null; amount: string | null; rawAmount: string };
  timestamp: string;
}
/** A cross-chain hop (ADR 0012): two real transactions, one per chain. */
interface BridgeEdge {
  id: string;
  hash: string;
  source: string;
  target: string;
  sourceChain: ChainId;
  targetChain: ChainId;
  direction: "in" | "out";
  kind: "bridge";
  valueNative: "0";
  token: { address: string | null; symbol: string | null; amount: string | null };
  timestamp: string;
  bridge: {
    protocol: "wormhole";
    operationId: string;
    appIds: string[];
    sourceTxHash: string;
    targetTxHash: string;
    targetTimestamp: string | null;
    evidence: "wormholescan";
    evidenceUrl: string;
  };
}
type TraceEdge = ChainEdge | BridgeEdge;
interface FrontierNode {
  id: string;
  reason: "depth-cap" | "breadth-cap" | "budget-exhausted" | "unavailable";
}
interface BridgeDeadEnd {
  operationId: string;
  nodeId: string;
  nodeChain: ChainId;
  direction: "in" | "out";
  reason: "no-destination-tx" | "counterparty-chain-unsupported" | "counterparty-address-unresolved";
  sourceTxHash: string;
  sourceWormholeChainId: number;
  targetWormholeChainId: number;
  counterparty: string | null;
  evidenceUrl: string;
}
interface BridgeReport {
  enabled: boolean;
  protocol: "wormhole" | null;
  lookupsUsed: number;
  lookupFailures: { id: string; chain: ChainId; reason: string }[];
  deadEnds: BridgeDeadEnd[];
  malformedOperations: number;
}
interface TraceGraphReport {
  center: { chain: ChainId; value: string };
  nodes: TracedNode[];
  edges: TraceEdge[];
  expandedIds: string[];
  frontier: FrontierNode[];
  nodeChains: Record<string, ChainId>;
  adapterCallsUsed: number;
  budgetExhausted: boolean;
  bridges: BridgeReport;
}
interface TracePathReport {
  from: { chain: ChainId; value: string };
  to: { chain: ChainId; value: string };
  found: boolean;
  path: TraceEdge[];
  nodes: TracedNode[];
  nodeChains: Record<string, ChainId>;
  hopsSearched: number;
  nodesExplored: number;
  adapterCallsUsed: number;
  budgetExhausted: boolean;
  bridges: BridgeReport;
}

type TraceState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "graph"; report: TraceGraphReport }
  | { status: "path"; report: TracePathReport };

const FRONTIER_TEXT: Record<FrontierNode["reason"], string> = {
  "depth-cap": "reached, not expanded — past the hop limit",
  "breadth-cap": "reached, not expanded — not among the most-recently-active counterparties kept",
  "budget-exhausted": "reached, not expanded — the call budget ran out first",
  unavailable: "the chain adapter couldn't check this address",
};

function short(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

const DEAD_END_TEXT: Record<BridgeDeadEnd["reason"], string> = {
  "no-destination-tx": "Wormholescan has no destination-chain transaction for it (not yet redeemed, or not indexed — can't tell which)",
  "counterparty-chain-unsupported": "the other side is on a chain OSSTrace doesn't support",
  "counterparty-address-unresolved": "the other side's address couldn't be resolved",
};

function txUrl(chain: ChainId, hash: string): string {
  return chain === "ethereum" ? `https://etherscan.io/tx/${hash}` : `https://solscan.io/tx/${hash}`;
}

function edgeAmountText(edge: TraceEdge): string {
  if (edge.kind === "native") return `${edge.valueNative} native`;
  const unit = edge.token?.symbol ?? (edge.token?.address ? short(edge.token.address) : "unknown token");
  if (edge.kind === "bridge") return edge.token.amount !== null ? `${edge.token.amount} ${unit}` : `amount not reported (${unit})`;
  return edge.token?.amount !== null && edge.token?.amount !== undefined ? `${edge.token.amount} ${unit}` : `${edge.token?.rawAmount ?? "?"} raw units of ${unit}`;
}

/** `initial` comes from a `#trace/<chain>/<address>` link (a Lookup report's "Trace funds"): it prefills From. */
export default function TracerView({ initial = null }: { initial?: { chain: ChainId; address: string } | null }) {
  const [chain, setChain] = useState<ChainId>(initial?.chain ?? "ethereum");
  const [from, setFrom] = useState(initial?.address ?? "");
  const [to, setTo] = useState("");
  const [maxHops, setMaxHops] = useState(2);
  const [breadth, setBreadth] = useState(5);
  const [token, setToken] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [since, setSince] = useState("");
  const [toChain, setToChain] = useState<ChainId>("ethereum");
  const [followBridges, setFollowBridges] = useState(false);
  const [state, setState] = useState<TraceState>({ status: "idle" });
  const effectiveToChain = followBridges ? toChain : chain;

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const fromTrimmed = from.trim();
    const toTrimmed = to.trim();
    if (!fromTrimmed) return;
    setState({ status: "loading" });
    try {
      if (toTrimmed) {
        const params = new URLSearchParams({ from: fromTrimmed, to: toTrimmed, maxHops: String(maxHops), breadth: String(breadth) });
        if (token.trim()) params.set("token", token.trim());
        if (minAmount.trim()) params.set("minAmount", minAmount.trim());
        if (since.trim()) params.set("since", new Date(since).toISOString());
        params.set("toChain", effectiveToChain);
        if (followBridges) params.set("bridges", "wormhole");
        const res = await fetch(`${TRACER_URL}/trace/path/${chain}?${params}`);
        const body = (await res.json()) as TracePathReport | { error: string };
        if (!res.ok || "error" in body) {
          setState({ status: "error", message: "error" in body ? body.error : `HTTP ${res.status}` });
          return;
        }
        setState({ status: "path", report: body });
      } else {
        const params = new URLSearchParams({ maxHops: String(maxHops), breadth: String(breadth) });
        if (followBridges) params.set("bridges", "wormhole");
        const res = await fetch(`${TRACER_URL}/trace/graph/${chain}/${encodeURIComponent(fromTrimmed)}?${params}`);
        const body = (await res.json()) as TraceGraphReport | { error: string };
        if (!res.ok || "error" in body) {
          setState({ status: "error", message: "error" in body ? body.error : `HTTP ${res.status}` });
          return;
        }
        setState({ status: "graph", report: body });
      }
    } catch (cause) {
      setState({ status: "error", message: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  const pathMode = to.trim() !== "";

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5">
      <PageHeader
        title="Tracer"
        description="Follow funds outward from an address, up to three hops. Add a destination to check whether a real path connects the two."
      />

      <form onSubmit={handleSubmit} className="card overflow-hidden">
        <div className="grid gap-3 p-4 sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)]">
          <Field label="Chain">
            <select value={chain} onChange={(e) => setChain(e.target.value as ChainId)} className="ctl w-full">
              <option value="ethereum">Ethereum</option>
              <option value="solana">Solana</option>
            </select>
          </Field>
          <Field label="From">
            <input
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder={chain === "ethereum" ? "0x…" : "Solana address"}
              required
              spellCheck={false}
              className="ctl hash w-full"
            />
          </Field>
          <Field label="To (optional)">
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="Leave blank to expand the graph"
              spellCheck={false}
              className="ctl hash w-full"
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3 border-t border-line bg-ground/40 p-4 sm:grid-cols-3 lg:grid-cols-6">
          <Field label="Hops">
            <select value={maxHops} onChange={(e) => setMaxHops(Number(e.target.value))} className="ctl w-full">
              {[1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Breadth per hop">
            <select value={breadth} onChange={(e) => setBreadth(Number(e.target.value))} className="ctl w-full">
              {[3, 5, 10].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          {/* The API applies these to path searches only, so they're inert until a destination is set. */}
          <Field label="Token" hint={pathMode ? undefined : "path only"}>
            <input value={token} onChange={(e) => setToken(e.target.value)} disabled={!pathMode} placeholder="USDC, native…" className="ctl w-full disabled:opacity-40" />
          </Field>
          <Field label="Min amount" hint={pathMode ? undefined : "path only"}>
            <input value={minAmount} onChange={(e) => setMinAmount(e.target.value)} disabled={!pathMode} placeholder="0" className="ctl num w-full disabled:opacity-40" />
          </Field>
          <Field label="Since" hint={pathMode ? undefined : "path only"}>
            <input type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)} disabled={!pathMode} className="ctl w-full disabled:opacity-40" />
          </Field>
          {followBridges && pathMode ? (
            <Field label="To chain">
              <select value={toChain} onChange={(e) => setToChain(e.target.value as ChainId)} className="ctl w-full">
                <option value="ethereum">Ethereum</option>
                <option value="solana">Solana</option>
              </select>
            </Field>
          ) : (
            <div />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
          <Checkbox checked={followBridges} onCheckedChange={setFollowBridges}>
            Follow Wormhole bridges
          </Checkbox>
          <button type="submit" disabled={state.status === "loading"} className="btn-accent ml-auto shrink-0">
            {state.status === "loading" ? "Tracing…" : pathMode ? "Find path" : "Expand graph"}
          </button>
        </div>
      </form>

      <details className="px-1 text-xs text-ink-faint">
        <summary className="cursor-pointer list-none underline decoration-line-strong underline-offset-2 hover:text-ink-dim">How tracing works</summary>
        <p className="mt-2 max-w-2xl leading-relaxed">
          Filters apply to <em>every</em> hop of a found path, so a result is one continuous qualifying flow (
          <a href={ADR_URL + "0008-tracer-multi-hop-search-design.md"} target="_blank" rel="noreferrer" className="underline hover:text-ink">
            ADR 0008
          </a>
          ). With bridges on, a Wormhole transfer between Ethereum and Solana is followed onto the other chain, linked by
          Wormholescan's index rather than re-checked on either chain (
          <a href={ADR_URL + "0012-tracer-cross-chain-bridge-hops-via-wormhole.md"} target="_blank" rel="noreferrer" className="underline hover:text-ink">
            ADR 0012
          </a>
          ).
        </p>
      </details>

      {state.status === "error" && <Notice tone="danger">{state.message}</Notice>}
      {state.status === "loading" && <Loading label="Tracing — this makes real chain calls and can take a moment…" />}
      {state.status === "path" && <PathResult report={state.report} />}
      {state.status === "graph" && <GraphExpansionResult report={state.report} />}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string | undefined; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="flex items-baseline justify-between gap-2 text-xs font-medium text-ink-faint">
        {label}
        {hint && <span className="font-normal text-ink-faint/70">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function BudgetNote({ budgetExhausted }: { budgetExhausted: boolean }) {
  if (!budgetExhausted) return null;
  return (
    <Notice tone="warn">
      The call budget ran out first, so this result is <strong>truncated, not exhaustive</strong>. A "not found" doesn't
      disprove a path.
    </Notice>
  );
}

function EdgeRow({ edge, chain }: { edge: TraceEdge; chain: ChainId }) {
  if (edge.kind === "bridge") return <BridgeEdgeRow edge={edge} />;
  const url = txUrl(chain, edge.hash);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <div className="min-w-0">
        <a href={url} target="_blank" rel="noreferrer" className="hash block truncate text-xs text-ink-faint hover:text-ink">
          {edge.hash}
        </a>
        <div className="hash text-xs text-ink-faint">
          {short(edge.source)} → {short(edge.target)} · {new Date(edge.timestamp).toLocaleString()}
        </div>
      </div>
      <div className={`num shrink-0 text-right text-sm ${edge.direction === "in" ? "text-inbound" : "text-outbound"}`}>{edgeAmountText(edge)}</div>
    </li>
  );
}

function BridgeEdgeRow({ edge }: { edge: BridgeEdge }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <div className="min-w-0">
        <div className="text-xs text-ink">
          <span className="chip border-line-strong text-ink-dim">bridge · {edge.bridge.protocol}</span>{" "}
          {edge.sourceChain} → {edge.targetChain}
          {edge.bridge.appIds.length > 0 && <span className="ml-2 text-ink-faint">{edge.bridge.appIds.join(", ")}</span>}
        </div>
        <a href={txUrl(edge.sourceChain, edge.bridge.sourceTxHash)} target="_blank" rel="noreferrer" className="hash block truncate text-xs text-ink-faint hover:text-ink">
          {edge.sourceChain}: {edge.bridge.sourceTxHash}
        </a>
        <a href={txUrl(edge.targetChain, edge.bridge.targetTxHash)} target="_blank" rel="noreferrer" className="hash block truncate text-xs text-ink-faint hover:text-ink">
          {edge.targetChain}: {edge.bridge.targetTxHash}
        </a>
        <div className="hash text-xs text-ink-faint">
          {short(edge.source)} → {short(edge.target)} · {new Date(edge.timestamp).toLocaleString()} ·{" "}
          <a href={edge.bridge.evidenceUrl} target="_blank" rel="noreferrer" className="underline hover:text-ink">
            Wormholescan record
          </a>
        </div>
      </div>
      <div className={`num shrink-0 text-right text-sm ${edge.direction === "in" ? "text-inbound" : "text-outbound"}`}>{edgeAmountText(edge)}</div>
    </li>
  );
}

function BridgeNotes({ bridges }: { bridges: BridgeReport }) {
  if (!bridges.enabled) return null;
  if (bridges.deadEnds.length === 0 && bridges.lookupFailures.length === 0) return null;
  return (
    <section className="card overflow-hidden">
      <div className="card-header">
        <h2 className="text-[15px] font-medium text-ink">Bridge activity not followed</h2>
        <span className="text-xs text-ink-faint">
          <span className="num font-medium text-ink">{bridges.lookupsUsed}</span> Wormholescan lookups
        </span>
      </div>
      <ul className="divide-y divide-line px-4 text-sm">
        {bridges.lookupFailures.map((f) => (
          <li key={`fail-${f.id}`} className="flex items-center justify-between gap-2 py-2">
            <span className="hash min-w-0 truncate text-ink-dim">{short(f.id)}</span>
            <span className="shrink-0 text-xs text-warn">couldn't check for bridge activity: {f.reason}</span>
          </li>
        ))}
        {bridges.deadEnds.map((d) => (
          <li key={`${d.operationId}-${d.nodeId}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <a href={d.evidenceUrl} target="_blank" rel="noreferrer" className="hash min-w-0 truncate text-xs text-ink-dim hover:text-ink">
              {short(d.nodeId)} {d.direction === "out" ? "sent" : "received"} · Wormhole chain {d.sourceWormholeChainId} → {d.targetWormholeChainId}
            </a>
            <span className="shrink-0 text-xs text-ink-faint">{DEAD_END_TEXT[d.reason]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PathResult({ report }: { report: TracePathReport }) {
  return (
    <div className="space-y-4">
      <Notice tone={report.found ? "success" : "info"}>
        {report.found ? (
          <>
            <strong className="text-signal">Path found</strong> — {report.hopsSearched} hop{report.hopsSearched === 1 ? "" : "s"}, every edge matches the filters.
          </>
        ) : (
          <>
            <strong className="text-ink">No matching path found</strong> within {report.hopsSearched} hop{report.hopsSearched === 1 ? "" : "s"} ({report.nodesExplored} addresses checked).
          </>
        )}
      </Notice>
      <BudgetNote budgetExhausted={report.budgetExhausted} />
      {report.found && (
        <section className="card overflow-hidden">
          <div className="card-header">
            <h2 className="text-[15px] font-medium text-ink">Path, hop by hop</h2>
            <span className="text-xs text-ink-faint">
              <span className="num font-medium text-ink">{report.adapterCallsUsed}</span> chain calls used
            </span>
          </div>
          <ol className="divide-y divide-line px-4">
            {report.path.map((edge) => (
              <EdgeRow key={edge.id} edge={edge} chain={report.nodeChains[edge.source] ?? report.from.chain} />
            ))}
          </ol>
        </section>
      )}
      <BridgeNotes bridges={report.bridges} />
    </div>
  );
}

function GraphExpansionResult({ report }: { report: TraceGraphReport }) {
  const byReason = new Map<FrontierNode["reason"], number>();
  for (const f of report.frontier) byReason.set(f.reason, (byReason.get(f.reason) ?? 0) + 1);
  const nodesById = new Map(report.nodes.map((n) => [n.id, n]));

  return (
    <div className="space-y-4">
      <BudgetNote budgetExhausted={report.budgetExhausted} />
      <section className="card overflow-hidden">
        <div className="card-header">
          <h2 className="text-[15px] font-medium text-ink">Expanded graph</h2>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-faint">
            <span>
              <span className="num font-medium text-ink">{report.expandedIds.length}</span> nodes expanded
            </span>
            <span>
              <span className="num font-medium text-ink">{report.edges.length}</span> real edges
            </span>
            <span>
              <span className="num font-medium text-ink">{report.adapterCallsUsed}</span> chain calls used
            </span>
          </div>
        </div>
        <ol className="divide-y divide-line px-4">
          {report.edges.map((edge) => (
            <EdgeRow key={edge.id} edge={edge} chain={report.nodeChains[edge.source] ?? report.center.chain} />
          ))}
        </ol>
      </section>

      {report.frontier.length > 0 && (
        <section className="card overflow-hidden">
          <div className="card-header">
            <h2 className="text-[15px] font-medium text-ink">Not expanded further</h2>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-faint">
              {[...byReason.entries()].map(([reason, count]) => (
                <span key={reason} className="chip border-line-strong text-ink-dim">
                  {count} {reason}
                </span>
              ))}
            </div>
          </div>
          <ul className="divide-y divide-line px-4 text-sm">
            {report.frontier.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-2 py-2">
                <span className="hash min-w-0 truncate text-ink-dim">
                  {short(f.id)}
                  {nodesById.get(f.id)?.label && <span className="ml-2 text-ink-faint">({nodesById.get(f.id)?.label?.name})</span>}
                </span>
                <span className="shrink-0 text-xs text-ink-faint">{FRONTIER_TEXT[f.reason]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <BridgeNotes bridges={report.bridges} />
    </div>
  );
}
