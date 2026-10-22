import { normalizeAddress, type AddressInfo, type Chain, type Transfer } from "@osstrace/contract";
import { ListPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "../kit/Button.tsx";
import { cn } from "../kit/cn.ts";
import { EmptyState, ErrorNotice, SkeletonRows } from "../kit/QueryState.tsx";
import { SyncBadge } from "../kit/SyncBadge.tsx";
import { useTransfers } from "./hooks.ts";
import { DEFAULT_TRANSFER_FILTER, subjectKey, TIME_PRESETS, tokenOptions, type TransferFilter } from "./model.ts";
import { FilterChip, formatCount, NumberField, PanelStrip, SegTabs } from "./parts.tsx";
import { TransferTable, type SortKey, type TransferRowActions } from "./TransferTable.tsx";

export type TransfersPanelProps = {
  chain: Chain;
  address: string;
  /** Narrow to transfers with one counterparty (bare address or `chain:address`). */
  counterparty?: string;
  /** Override the base set (several `chain:address` keys); defaults to [chain:address]. */
  base?: string[];
  title?: string;
  showSelfTab?: boolean;
  actions?: TransferRowActions & { onAddMany?: (ts: Transfer[]) => void };
  onSelect?: (t: Transfer) => void;
  selectedId?: string | null;
  defaultFilter?: Partial<TransferFilter>;
  className?: string;
  /** Host-controlled direction (e.g. a page-level TRANSFERS / INFLOW / OUTFLOW bar). When set, it wins. */
  flow?: TransferFilter["flow"];
  onFlowChange?: (flow: TransferFilter["flow"]) => void;
  /** Hide the panel's own direction tab strip (the host renders its own). */
  hideTabs?: boolean;
};

const keyOf = (chain: Chain, a: string) => {
  try {
    return subjectKey(chain, normalizeAddress(chain, a));
  } catch {
    return subjectKey(chain, a);
  }
};

/** Transfers of an address from GET /transfers with keyset cursor paging. */
export function TransfersPanel(props: TransfersPanelProps) {
  const { chain, address, counterparty, title = "Transfers", showSelfTab, actions, onSelect, selectedId, defaultFilter, className } = props;
  const base = useMemo(() => props.base ?? [keyOf(chain, address)], [props.base, chain, address]);
  const cps = useMemo(() => (counterparty ? [counterparty.includes(":") ? counterparty : keyOf(chain, counterparty)] : null), [counterparty, chain]);
  const [filter, setFilter] = useState<TransferFilter>({ ...DEFAULT_TRANSFER_FILTER, ...defaultFilter });
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const page = cursors.length - 1;
  useEffect(() => setCursors([null]), [filter, base.join("|"), cps?.join("|")]);
  const q = useTransfers({ base, counterparties: cps, filter, cursor: cursors[page] });
  const rows = q.data?.transfers ?? [];
  const [knownTokens, setKnownTokens] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    if (!rows.length) return;
    setKnownTokens((prev) => {
      const m = new Map(prev.map((t) => [t.id, t]));
      for (const t of tokenOptions(rows)) m.set(t.id, t);
      return [...m.values()].sort((a, b) => a.label.localeCompare(b.label));
    });
  }, [rows]);
  const set = (p: Partial<TransferFilter>) => setFilter((f) => ({ ...f, ...p }));
  useEffect(() => {
    if (props.flow && props.flow !== filter.flow) set({ flow: props.flow });
  }, [props.flow]); // eslint-disable-line react-hooks/exhaustive-deps
  const setFlow = (flow: TransferFilter["flow"]) => {
    set({ flow });
    props.onFlowChange?.(flow);
  };
  const onSort = (k: SortKey) => set(filter.sortKey === k ? { sortDir: filter.sortDir === "desc" ? "asc" : "desc" } : { sortKey: k, sortDir: "desc" });
  const baseSet = useMemo(() => new Set(base.map((b) => b.toLowerCase())), [base]);
  const isBase = (a: AddressInfo) => baseSet.has(subjectKey(a.chain, a.address).toLowerCase());
  const eligible = actions ? rows.filter((t) => actions.stateOf(t) === "add") : [];
  const tabs = [
    { value: "all" as const, label: title },
    { value: "in" as const, label: "Incoming" },
    { value: "out" as const, label: "Outgoing" },
    ...(showSelfTab ? [{ value: "self" as const, label: "Self" }] : []),
  ];

  const addMany = actions?.onAddMany && eligible.length > 1 ? (
    <Button size="sm" icon={<ListPlus aria-hidden className="size-3.5" />} onClick={() => actions.onAddMany!(eligible)}>
      Add {eligible.length}
    </Button>
  ) : null;

  return (
    <section aria-label={title} className={cn("flex min-h-0 flex-col", className)} data-canvas-scroll-region>
      <header className="shrink-0">
        {props.hideTabs ? null : (
          <PanelStrip aside={addMany}>
            <SegTabs variant="tabs" label="Direction" value={filter.flow} onChange={setFlow} items={tabs} />
          </PanelStrip>
        )}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
          <FilterChip label="USD ≥" value={filter.usdGte != null ? `$${filter.usdGte}` : undefined} active={filter.usdGte != null}>
            <div className="flex flex-col gap-2">
              <NumberField label="Minimum USD" value={filter.usdGte} onCommit={(usdGte) => set({ usdGte })} placeholder="No minimum" />
              <NumberField label="Maximum USD" value={filter.usdLte} onCommit={(usdLte) => set({ usdLte })} placeholder="No maximum" />
              <p className="max-w-56 text-xs text-faint">A USD floor hides transfers without a price.</p>
            </div>
          </FilterChip>
          <FilterChip label="Time" value={TIME_PRESETS.find((p) => p.value === filter.timeLast)?.label} active={filter.timeLast !== "all"}>
            <div className="grid grid-cols-3 gap-1" role="radiogroup" aria-label="Time range">
              {TIME_PRESETS.map((p) => (
                <button key={p.value} type="button" role="radio" aria-checked={filter.timeLast === p.value} onClick={() => set({ timeLast: p.value })}
                  className={cn("kit-fade h-7 rounded-sm border px-2 text-xs", filter.timeLast === p.value ? "border-accent text-text" : "border-border text-muted hover:text-text")}>
                  {p.label}
                </button>
              ))}
            </div>
          </FilterChip>
          <FilterChip label="Token" value={filter.tokens?.length ? `${filter.tokens.length}` : undefined} active={!!filter.tokens?.length}>
            {knownTokens.length === 0 ? (
              <p className="text-xs text-muted">Tokens appear here once transfers have loaded.</p>
            ) : (
              <div className="flex max-h-60 flex-col gap-1 overflow-auto">
                {knownTokens.map((t) => {
                  const on = filter.tokens?.includes(t.id) ?? false;
                  return (
                    <label key={t.id} className="flex cursor-pointer items-center gap-2 text-[13px]">
                      <input type="checkbox" className="size-3.5 accent-[var(--trace-accent)]" checked={on}
                        onChange={() => {
                          const cur = new Set(filter.tokens ?? []);
                          if (on) cur.delete(t.id);
                          else cur.add(t.id);
                          set({ tokens: cur.size ? [...cur] : null });
                        }} />
                      <span className="kit-mono">{t.label}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </FilterChip>
          {props.hideTabs && addMany ? <div className="ml-auto">{addMany}</div> : null}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {q.error && !q.data ? (
          <div className="p-3">
            <ErrorNotice error={q.error} title="Unable to load transfers right now" onRetry={() => void q.refetch()} />
          </div>
        ) : q.isPending ? (
          <SkeletonRows rows={8} />
        ) : rows.length === 0 ? (
          <EmptyState title="No transfers found." body={filter.usdGte ? "The USD floor hides unpriced and small transfers." : q.data?.sync.state === "partial" ? "Only part of this history is cached so far." : undefined} />
        ) : (
          <div className={cn(q.isFetching && "opacity-70")}>
            <TransferTable rows={rows} sortKey={filter.sortKey} sortDir={filter.sortDir} onSort={onSort} actions={actions} isBase={isBase} onSelect={onSelect} selectedId={selectedId} label={`${title} for ${address}`} />
          </div>
        )}
      </div>
      <footer className="flex min-h-9 flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-1 text-xs text-faint">
        <span className="flex items-center gap-2">
          <span className="kit-num">{q.data ? `${formatCount(q.data.count.value)}${q.data.count.capped ? "+" : ""} matching in cache` : ""}</span>
          <SyncBadge sync={q.data?.sync} />
        </span>
        <span className="flex items-center gap-1">
          <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setCursors((c) => c.slice(0, -1))}>Newer</Button>
          <span className="kit-num px-1">page {page + 1}</span>
          <Button size="sm" variant="ghost" disabled={!q.data?.nextCursor} onClick={() => q.data?.nextCursor && setCursors((c) => [...c, q.data!.nextCursor])}>Older</Button>
        </span>
      </footer>
    </section>
  );
}
