import type { Chain } from "@osstrace/contract";
import { Check, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AddressChip } from "../kit/AddressChip.tsx";
import { ChainBadge } from "../kit/ChainBadge.tsx";
import { cn } from "../kit/cn.ts";
import { ErrorNotice, EmptyState, SkeletonRows } from "../kit/QueryState.tsx";
import { SyncBadge } from "../kit/SyncBadge.tsx";
import { UsdValue } from "../kit/UsdValue.tsx";
import { mergeSync, useCounterparties } from "./hooks.ts";
import { counterpartyRows, DEFAULT_COUNTERPARTY_FILTER, pageCount, paginate, TIME_PRESETS, type CounterpartyFilter, type CounterpartyRow } from "./model.ts";
import { FilterChip, formatCount, NumberField, Pager, PanelStrip, SegTabs } from "./parts.tsx";

export type RowActionState = "add" | "added" | "disabled" | "busy";

export type CounterpartiesPanelProps = {
  chain: Chain;
  address: string;
  /** Simple add callback (explorer page). */
  onAddToGraph?: (address: string, chain: Chain) => void;
  /** Rich row actions (tracer): state per row, add with directional stats, remove. */
  rowState?: (row: CounterpartyRow) => RowActionState;
  onAddRow?: (row: CounterpartyRow) => void;
  onRemoveRow?: (row: CounterpartyRow) => void;
  /** Row click toggles a counterparty selection (filters the transfers panel). */
  selectedKey?: string | null;
  onSelectRow?: (row: CounterpartyRow | null) => void;
  title?: string;
  className?: string;
  /** Host-controlled direction (e.g. a page-level tab bar). When set, it wins over the panel's own tabs. */
  flow?: CounterpartyFilter["flow"];
  onFlowChange?: (flow: CounterpartyFilter["flow"]) => void;
  /** Hide the panel's own direction tab strip (the host renders its own). */
  hideTabs?: boolean;
};

const PAGE_SIZE = 10;

/** Counterparties of one address: in/out merged client-side, grouped by entity on demand. */
export function CounterpartiesPanel(props: CounterpartiesPanelProps) {
  const { chain, address, onAddToGraph, rowState, onAddRow, onRemoveRow, selectedKey, onSelectRow, title = "Counterparties", className } = props;
  const [filter, setFilter] = useState<CounterpartyFilter>(DEFAULT_COUNTERPARTY_FILTER);
  const [page, setPage] = useState(0);
  useEffect(() => {
    if (props.flow && props.flow !== filter.flow) setFilter((f) => ({ ...f, flow: props.flow! }));
  }, [props.flow]); // eslint-disable-line react-hooks/exhaustive-deps
  const setFlow = (flow: CounterpartyFilter["flow"]) => {
    setFilter((f) => ({ ...f, flow }));
    props.onFlowChange?.(flow);
  };
  const { inQ, outQ } = useCounterparties(chain, address, filter);

  const rows = useMemo(
    () =>
      counterpartyRows({
        inRows: inQ.data?.counterparties ?? [],
        outRows: outQ.data?.counterparties ?? [],
        flow: filter.flow,
        base: { chain, address },
        group: filter.group,
        sortKey: filter.sortKey,
        sortDir: filter.sortDir,
      }),
    [inQ.data, outQ.data, filter, chain, address],
  );
  useEffect(() => setPage(0), [filter, chain, address]);
  const pages = pageCount(rows.length, PAGE_SIZE);
  const visible = paginate(rows, Math.min(page, pages - 1), PAGE_SIZE);
  const sync = mergeSync(inQ.data?.sync, outQ.data?.sync);
  const loading = (inQ.isPending || outQ.isPending) && !inQ.data && !outQ.data;
  const error = inQ.error ?? outQ.error;
  const set = (p: Partial<CounterpartyFilter>) => setFilter((f) => ({ ...f, ...p }));
  const hasActions = !!(onAddRow || onAddToGraph);
  const sortBy = (k: CounterpartyFilter["sortKey"]) => set(filter.sortKey === k ? { sortDir: filter.sortDir === "desc" ? "asc" : "desc" } : { sortKey: k, sortDir: "desc" });

  return (
    <section aria-label={title} className={cn("flex min-h-0 flex-col", className)} data-canvas-scroll-region>
      <header className="shrink-0">
        {props.hideTabs ? null : <PanelStrip>
          <SegTabs variant="tabs" label="Direction" value={filter.flow} onChange={setFlow} items={[{ value: "all", label: title }, { value: "in", label: "Incoming" }, { value: "out", label: "Outgoing" }]} />
        </PanelStrip>}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
          <SegTabs label="Grouping" value={filter.group ? "group" : "flat"} onChange={(v) => set({ group: v === "group" })} items={[{ value: "flat", label: "Addresses" }, { value: "group", label: "By entity" }]} />
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
          <FilterChip label="USD ≥" value={filter.usdGte != null ? `$${filter.usdGte}` : undefined} active={filter.usdGte != null}>
            <NumberField label="Minimum USD per transfer" value={filter.usdGte} onCommit={(usdGte) => set({ usdGte })} placeholder="No minimum" />
          </FilterChip>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {error && !inQ.data && !outQ.data ? (
          <div className="p-3">
            <ErrorNotice error={error} title="Unable to load counterparties right now" onRetry={() => void Promise.all([inQ.refetch(), outQ.refetch()])} />
          </div>
        ) : loading ? (
          <SkeletonRows rows={6} />
        ) : rows.length === 0 ? (
          <EmptyState title="No counterparties found." body={filter.timeLast !== "all" ? "Try a longer time range or a lower USD floor." : sync?.state === "partial" ? "Only part of this address's history is cached so far." : undefined} />
        ) : (
          <table className="kit-gtable w-full border-collapse text-[13px]" aria-label={`${title} of ${address}`}>
            <thead className="sticky top-0 z-[1]">
              <tr>
                {hasActions ? <th scope="col" className="w-9"><span className="sr-only">Actions</span></th> : null}
                <th scope="col" className="kit-colhead h-8 px-2 text-left">Counterparty</th>
                <th scope="col" className="kit-colhead h-8 px-2 text-left">Chain</th>
                <th scope="col" className="h-8 px-2 text-right" aria-sort={filter.sortKey === "tx" ? (filter.sortDir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" className="kit-colhead hover:text-text" onClick={() => sortBy("tx")}>TX{filter.sortKey === "tx" ? (filter.sortDir === "asc" ? " ↑" : " ↓") : ""}</button>
                </th>
                <th scope="col" className="h-8 px-2 pr-3 text-right" aria-sort={filter.sortKey === "usd" ? (filter.sortDir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" className="kit-colhead hover:text-text" onClick={() => sortBy("usd")}>USD{filter.sortKey === "usd" ? (filter.sortDir === "asc" ? " ↑" : " ↓") : ""}</button>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const selected = selectedKey === r.key;
                const state: RowActionState = rowState ? rowState(r) : "add";
                return (
                  <tr key={r.key} data-selected={selected || undefined} className={cn("kit-tr", onSelectRow && "cursor-pointer")}
                    onClick={onSelectRow ? () => onSelectRow(selected ? null : r) : undefined}>
                    {hasActions ? (
                      <td className="h-9 pl-2" onClick={(e) => e.stopPropagation()}>
                        <RowAction state={state} label={r.kind === "entity" ? r.entity.name : r.address.address}
                          onAdd={() => (onAddRow ? onAddRow(r) : r.kind === "address" ? onAddToGraph?.(r.address.address, r.address.chain) : undefined)}
                          onRemove={onRemoveRow ? () => onRemoveRow(r) : undefined}
                          disabledReason={!onAddRow && r.kind === "entity" ? "Ungroup to add single addresses" : undefined} />
                      </td>
                    ) : null}
                    <td className="h-9 max-w-0 px-2">
                      {r.kind === "entity" ? (
                        <span className="flex min-w-0 items-baseline gap-1.5">
                          <span className="truncate font-medium">{r.entity.name}</span>
                          <span className="kit-mono shrink-0 text-xs text-faint">{r.members.length} addr</span>
                        </span>
                      ) : (
                        <AddressChip info={r.address} />
                      )}
                    </td>
                    <td className="h-9 px-2">
                      <span className="flex gap-1">{r.chains.map((c) => <ChainBadge key={c} chain={c} />)}</span>
                    </td>
                    <td className="kit-num h-9 px-2 text-right">{formatCount(r.transactionCount)}</td>
                    <td className="kit-num h-9 px-2 pr-3 text-right"><UsdValue value={r.usd} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <footer className="flex min-h-9 flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-1 text-xs text-faint">
        <span className="flex items-center gap-2">
          <span className="kit-num">{rows.length ? `${rows.length} ${filter.group ? "rows" : "counterparties"}` : ""}</span>
          <SyncBadge sync={sync} />
        </span>
        <Pager page={Math.min(page, pages - 1)} pages={pages} onPage={setPage} label="Counterparty pages" />
      </footer>
    </section>
  );
}

export function RowAction({ state, label, onAdd, onRemove, disabledReason }: { state: RowActionState; label: string; onAdd: () => void; onRemove?: () => void; disabledReason?: string }) {
  if (state === "disabled" || disabledReason) return <span className="inline-block size-7" title={disabledReason ?? "Already on the canvas through an entity"} />;
  if (state === "busy") return <span className="inline-flex size-7 items-center justify-center text-faint" aria-label="Working"><span className="size-1.5 animate-pulse rounded-full bg-current" /></span>;
  if (state === "added")
    return (
      <button type="button" disabled={!onRemove} onClick={onRemove} aria-label={onRemove ? `Remove ${label} from the canvas` : `${label} is on the canvas`} title={onRemove ? "Remove from canvas" : "On the canvas"}
        className="group kit-fade inline-flex size-7 items-center justify-center rounded-sm text-in hover:bg-danger-soft hover:text-danger disabled:hover:bg-transparent disabled:hover:text-in">
        <Check aria-hidden className={cn("size-3.5", onRemove && "group-hover:hidden group-focus-visible:hidden")} />
        {onRemove ? <X aria-hidden className="hidden size-3.5 group-hover:block group-focus-visible:block" /> : null}
      </button>
    );
  return (
    <button type="button" onClick={onAdd} aria-label={`Add ${label} to the canvas`} title="Add to canvas" className="kit-fade inline-flex size-7 items-center justify-center rounded-sm text-muted hover:bg-surface-2 hover:text-text">
      <Plus aria-hidden className="size-3.5" />
    </button>
  );
}
