import type { AggregateSummaryResponse, TraceDoc, TraceEdge, TraceNode, Transfer } from "@osstrace/contract";
import { ArrowLeft, ArrowLeftRight, ArrowRight, Layers, X } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, IconButton } from "../kit/Button.tsx";
import { cn } from "../kit/cn.ts";
import { formatUsd, shortAddress } from "../kit/format.ts";
import { EmptyState, ErrorNotice } from "../kit/QueryState.tsx";
import { SyncBadge } from "../kit/SyncBadge.tsx";
import { CounterpartiesPanel, type RowActionState } from "../panels/CounterpartiesPanel.tsx";
import type { CounterpartyRow } from "../panels/model.ts";
import { formatRelative } from "../panels/parts.tsx";
import { TransfersPanel } from "../panels/TransfersPanel.tsx";
import { TransferTable, type TransferRowActions } from "../panels/TransferTable.tsx";
import { useEntity } from "./api.ts";
import { nodeTitle } from "./canvas/NodeCard.tsx";
import { edgesBetween } from "./lib/ops.ts";

export type InspectorController = {
  readOnly: boolean;
  counterpartyState: (base: TraceNode, row: CounterpartyRow) => RowActionState;
  addCounterparty: (base: TraceNode, row: CounterpartyRow) => void;
  removeCounterparty: (base: TraceNode, row: CounterpartyRow) => void;
  transferActions: (base: TraceNode) => TransferRowActions & { onAddMany?: (ts: Transfer[]) => void };
  removeEdges: (edgeIds: string[]) => void;
  aggregatePair: (a: TraceNode, b: TraceNode, summary: AggregateSummaryResponse | null) => void;
};

const WIDTH_KEY = "osstrace_tracer_inspector_width";
const clampW = (w: number) => Math.min(Math.min(760, window.innerWidth - 48), Math.max(window.innerWidth >= 1024 ? 460 : 320, w));
const readW = () => {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(n) && n > 0 ? n : 560;
  } catch {
    return 560;
  }
};

/** The inspector's on-screen width before it mounts (stored width, clamped like the live one). */
export const readInspectorWidth = () => (typeof window === "undefined" ? 560 : clampW(readW()));

/** Right-docked, resizable inspector whose content follows the selection. */
export function Inspector({ children, title, heading, onClose }: { children: ReactNode; title: string; heading?: ReactNode; onClose: () => void }) {
  const [width, setWidth] = useState(() => clampW(readW()));
  const drag = useRef<{ x: number; w: number } | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
    } catch {
      /* not persisted */
    }
  }, [width]);
  return (
    <aside aria-label={title} className="pointer-events-auto relative flex h-full flex-col" style={{ width }} data-canvas-scroll-region>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize inspector"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setWidth((w) => clampW(w + 24));
          if (e.key === "ArrowRight") setWidth((w) => clampW(w - 24));
        }}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, w: width };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => drag.current && setWidth(clampW(drag.current.w + (drag.current.x - e.clientX)))}
        onPointerUp={() => (drag.current = null)}
        className="absolute inset-y-0 left-0 z-[2] w-2 cursor-ew-resize hover:bg-accent-soft focus-visible:bg-accent-soft"
      />
      <HeaderCtx.Provider
        value={
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
            <h2 className="flex min-w-0 flex-1 items-center gap-2.5 text-[13px] font-semibold">{heading ?? <span className="truncate">{title}</span>}</h2>
            <IconButton size="sm" label="Close inspector (Esc)" onClick={onClose}><X aria-hidden className="size-3.5" /></IconButton>
          </header>
        }
      >
        {children}
      </HeaderCtx.Provider>
    </aside>
  );
}

const HeaderCtx = createContext<ReactNode>(null);

/** One floating inspector card. The first card of an inspector carries its header (title + close). */
function InspectorCard({ children, withHeader = true, style }: { children: ReactNode; withHeader?: boolean; style?: React.CSSProperties }) {
  const header = useContext(HeaderCtx);
  return (
    <div className="kit-overlay flex min-h-0 flex-col overflow-hidden" style={style ?? { flex: "1 1 0" }}>
      {withHeader ? header : null}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

/** Inspector heading for one node: identity tile, name (or short hash) and the full address in faint mono. */
export function NodeHeading({ node }: { node: TraceNode }) {
  const { title, mono } = nodeTitle(node);
  const addr = node.address ?? node.displayAddress?.address;
  return (
    <>
      <span aria-hidden className={cn("kit-node-tile flex size-7 shrink-0 items-center justify-center rounded-[5px]", node.kind === "entity" ? "text-[12px] font-semibold text-text" : "kit-mono text-[11px] font-semibold tracking-[0.02em]")}>
        {node.kind === "entity" ? (node.displayEntity?.name ?? "E").slice(0, 1).toUpperCase() : node.chain === "solana" ? "SOL" : "ETH"}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className={cn("truncate leading-tight", mono && "kit-mono text-[12.5px] font-medium")}>{mono ? shortAddress(title, 8, 6) : title}</span>
        {addr ? <span className="kit-mono truncate text-[11px] font-normal leading-tight text-faint" title={addr}>{addr}</span> : null}
      </span>
    </>
  );
}

/** Inspector heading for a pair: both short names joined by a two-way arrow. */
export function PairHeading({ a, b }: { a: TraceNode; b: TraceNode }) {
  const name = (n: TraceNode) => {
    const t = nodeTitle(n);
    return t.mono ? shortAddress(t.title, 6, 4) : t.title;
  };
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className={cn("min-w-0 truncate", nodeTitle(a).mono && "kit-mono text-[12.5px] font-medium")}>{name(a)}</span>
      <ArrowLeftRight aria-label="and" className="size-3.5 shrink-0 text-faint" />
      <span className={cn("min-w-0 truncate", nodeTitle(b).mono && "kit-mono text-[12.5px] font-medium")}>{name(b)}</span>
    </span>
  );
}

/** Vertical split with a draggable handle; fraction clamped 0.2..0.8. */
function Split({ top, bottom }: { top: ReactNode; bottom: ReactNode }) {
  const [frac, setFrac] = useState(0.5);
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  return (
    <div ref={ref} className="flex min-h-0 flex-1 flex-col">
      <InspectorCard style={{ flex: `${frac} 1 0` }}>{top}</InspectorCard>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize panels"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") setFrac((f) => Math.max(0.2, f - 0.05));
          if (e.key === "ArrowDown") setFrac((f) => Math.min(0.8, f + 0.05));
        }}
        onPointerDown={(e) => {
          dragging.current = true;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!dragging.current || !ref.current) return;
          const r = ref.current.getBoundingClientRect();
          setFrac(Math.min(0.8, Math.max(0.2, (e.clientY - r.top) / r.height)));
        }}
        onPointerUp={() => (dragging.current = false)}
        className="group relative h-3 shrink-0 cursor-ns-resize rounded-sm"
      >
        <span aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 h-[3px] w-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-border-strong group-hover:bg-accent" />
      </div>
      <InspectorCard withHeader={false} style={{ flex: `${1 - frac} 1 0` }}>{bottom}</InspectorCard>
    </div>
  );
}

export function NodeInspector({ node, ctl }: { node: TraceNode; ctl: InspectorController }) {
  const [cpKey, setCpKey] = useState<string | null>(null);
  useEffect(() => setCpKey(null), [node.id]);
  if (node.kind === "entity") return <InspectorCard><EntityInspector node={node} ctl={ctl} /></InspectorCard>;
  if (!node.chain || !node.address) return <InspectorCard><EmptyState title="This node has no address." /></InspectorCard>;
  const actions = ctl.readOnly ? undefined : ctl.transferActions(node);
  return (
    <Split
      top={
        <CounterpartiesPanel
          chain={node.chain}
          address={node.address}
          selectedKey={cpKey}
          onSelectRow={(r) => setCpKey(r?.kind === "address" ? r.key : null)}
          rowState={ctl.readOnly ? undefined : (r) => ctl.counterpartyState(node, r)}
          onAddRow={ctl.readOnly ? undefined : (r) => ctl.addCounterparty(node, r)}
          onRemoveRow={ctl.readOnly ? undefined : (r) => ctl.removeCounterparty(node, r)}
          className="flex-1"
        />
      }
      bottom={<TransfersPanel chain={node.chain} address={node.address} counterparty={cpKey ?? undefined} actions={actions} className="flex-1" />}
    />
  );
}

function EntityInspector({ node, ctl }: { node: TraceNode; ctl: InspectorController }) {
  const q = useEntity(node.entityID);
  if (q.error) return <div className="p-3"><ErrorNotice error={q.error} onRetry={() => void q.refetch()} /></div>;
  if (!q.data) return <p className="p-4 text-[13px] text-muted">Loading entity…</p>;
  const addrs = q.data.addresses;
  if (addrs.length === 0) return <EmptyState title="This entity has no addresses yet." body="Add addresses to it on the Labels page." />;
  const base = addrs.map((l) => `${l.chain}:${l.address}`);
  const first = addrs[0]!;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="border-b border-border px-4 py-2 text-xs text-muted">
        Transfers of all {addrs.length} addresses of {q.data.name}. Counterparties are listed per address: ungroup the entity to explore one.
      </p>
      <TransfersPanel chain={first.chain} address={first.address} base={base} actions={ctl.readOnly ? undefined : ctl.transferActions(node)} className="flex-1" />
    </div>
  );
}

export function PairInspector({ a, b, doc, ctl, summary }: { a: TraceNode; b: TraceNode; doc: TraceDoc; ctl: InspectorController; summary: { data?: AggregateSummaryResponse; error: unknown; isPending: boolean } }) {
  const edges = edgesBetween(doc, a.id, b.id);
  const agg = edges.find((e): e is Extract<TraceEdge, { kind: "aggregate" }> => e.kind === "aggregate");
  const transfers = edges.filter((e): e is Extract<TraceEdge, { kind: "transfer" }> => e.kind === "transfer");
  const rows = transfers.map((e) => e.displayTransfer).filter((t): t is Transfer => !!t).sort((x, y) => y.blockTimestamp.localeCompare(x.blockTimestamp));
  const s = summary.data;
  const canAggregate = !ctl.readOnly && (s ? s.cachedTransactionCountIn + s.cachedTransactionCountOut > 0 : transfers.length > 0);
  const top = (
    <section aria-label="Added transfers between the pair" className="flex min-h-0 flex-1 flex-col" data-canvas-scroll-region>
      <header className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface-2 px-3 py-1.5">
        <h3 className="kit-sect-h text-text">Between these nodes</h3>
        <span className="kit-num text-xs text-muted">
          {s ? (
            <>
              <span className="text-out">{formatUsd(s.cachedUSDOut)} out</span> · <span className="text-in">{formatUsd(s.cachedUSDIn)} in</span> · {s.cachedTransactionCountOut + s.cachedTransactionCountIn} tx
            </>
          ) : summary.isPending ? "Summing…" : ""}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {!ctl.readOnly && edges.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => ctl.removeEdges(edges.map((e) => e.id))}>Remove edge</Button>
          ) : null}
          {!ctl.readOnly ? (
            <Button size="sm" icon={<Layers aria-hidden className="size-3.5" />} disabled={!canAggregate || (!!agg && transfers.length === 0 && !s)} onClick={() => ctl.aggregatePair(a, b, s ?? null)}
              title={agg ? "Refresh the aggregate from the full history between the pair" : "Replace added transfers with one aggregate edge"}>
              {agg ? "Re-aggregate" : "Aggregate"}
            </Button>
          ) : null}
        </div>
        {s?.sync && s.sync.state !== "ready" ? <div className="basis-full"><SyncBadge sync={s.sync} /></div> : null}
      </header>
      {summary.error ? <div className="p-3"><ErrorNotice error={summary.error} title="Could not sum transfers between these nodes" /></div> : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {agg ? (
          <div className="px-3 py-3 text-[13px]">
            <p className="flex items-center gap-1.5 text-xs text-muted"><Layers aria-hidden className="size-3.5" /> Aggregate edge</p>
            <table className="kit-gtable mt-2 w-full table-fixed border-collapse" aria-label="Aggregated flow">
              <colgroup>
                <col />
                <col style={{ width: 96 }} />
                <col style={{ width: 120 }} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col" className="kit-colhead h-8 px-2 text-left">Direction</th>
                  <th scope="col" className="kit-colhead h-8 px-2 text-right">Transfers</th>
                  <th scope="col" className="kit-colhead h-8 px-2 text-right">USD</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const from = a.id === agg.fromNodeID ? a : b;
                  const to = from === a ? b : a;
                  const short = (n: TraceNode) => (nodeTitle(n).mono ? shortAddress(nodeTitle(n).title, 6, 4) : nodeTitle(n).title);
                  return (
                    <>
                      <tr className="kit-tr">
                        <td className="h-9 max-w-0 px-2"><span className="flex min-w-0 items-center gap-1.5"><ArrowRight aria-label="outgoing" className="size-3.5 shrink-0 text-out" /><span className="truncate">{short(from)} to {short(to)}</span></span></td>
                        <td className="kit-num h-9 px-2 text-right">{agg.aggregate.cachedTransactionCountOut.toLocaleString("en-US")}</td>
                        <td className="kit-num h-9 px-2 text-right text-out">{formatUsd(agg.aggregate.cachedUSDOut)}</td>
                      </tr>
                      <tr className="kit-tr">
                        <td className="h-9 max-w-0 px-2"><span className="flex min-w-0 items-center gap-1.5"><ArrowLeft aria-label="incoming" className="size-3.5 shrink-0 text-in" /><span className="truncate">{short(to)} back to {short(from)}</span></span></td>
                        <td className="kit-num h-9 px-2 text-right">{agg.aggregate.cachedTransactionCountIn.toLocaleString("en-US")}</td>
                        <td className="kit-num h-9 px-2 text-right text-in">{formatUsd(agg.aggregate.cachedUSDIn)}</td>
                      </tr>
                    </>
                  );
                })()}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-faint">Summed {formatRelative(agg.aggregate.cachedAt)} from the local transfer cache. Single transfers are listed below.</p>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState title="No added transfers between these nodes." body={ctl.readOnly ? undefined : "Add transfers from the table below, or aggregate the full history."} />
        ) : (
          <TransferTable rows={rows} label="Added transfers" actions={ctl.readOnly ? undefined : { stateOf: () => "added", onAdd: () => {}, onRemove: (t) => ctl.removeEdges(transfers.filter((e) => e.transferID === t.id).map((e) => e.id)) }} />
        )}
      </div>
    </section>
  );
  const bottom =
    a.kind === "address" && b.kind === "address" && a.chain && a.address && b.address ? (
      <TransfersPanel chain={a.chain} address={a.address} counterparty={`${b.chain}:${b.address}`} actions={ctl.readOnly ? undefined : ctl.transferActions(a)} className="flex-1" />
    ) : (
      <EmptyState title="Transfers between an entity and another node are listed after ungrouping the entity." />
    );
  return <Split top={top} bottom={bottom} />;
}

export function SummaryInspector({ doc, ctl }: { doc: TraceDoc; ctl: InspectorController }) {
  const transfers = doc.edges.filter((e): e is Extract<TraceEdge, { kind: "transfer" }> => e.kind === "transfer");
  const rows = transfers.map((e) => e.displayTransfer).filter((t): t is Transfer => !!t).sort((x, y) => y.blockTimestamp.localeCompare(x.blockTimestamp));
  const missing = transfers.length - rows.length;
  return (
    <InspectorCard>
    <div className={cn("min-h-0 flex-1 overflow-auto")} data-canvas-scroll-region>
      {rows.length === 0 ? (
        <EmptyState title="No added transfers in this trace." body={missing ? `${missing} transfer edges have no details loaded.` : "Transfers you add from a node's inspector appear here."} />
      ) : (
        <TransferTable rows={rows} label="Added transfers in this trace" actions={ctl.readOnly ? undefined : { stateOf: () => "added", onAdd: () => {}, onRemove: (t) => ctl.removeEdges(transfers.filter((e) => e.transferID === t.id).map((e) => e.id)) }} />
      )}
    </div>
    </InspectorCard>
  );
}
