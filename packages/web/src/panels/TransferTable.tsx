import type { AddressInfo, Transfer } from "@osstrace/contract";
import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { AddressChip } from "../kit/AddressChip.tsx";
import { ChainBadge } from "../kit/ChainBadge.tsx";
import { cn } from "../kit/cn.ts";
import { TokenAmount } from "../kit/TokenAmount.tsx";
import { UsdValue } from "../kit/UsdValue.tsx";
import { RowAction, type RowActionState } from "./CounterpartiesPanel.tsx";
import { transferDirection } from "./model.ts";
import { formatDateTime, formatRelative } from "./parts.tsx";

export type SortKey = "time" | "value" | "usd";

export type TransferRowActions = {
  stateOf: (t: Transfer) => RowActionState;
  onAdd: (t: Transfer) => void;
  onRemove?: (t: Transfer) => void;
};

/** Presentational ruled table of transfers; direction is inked relative to `isBase` when given. */
export function TransferTable({
  rows,
  sortKey,
  sortDir,
  onSort,
  actions,
  isBase,
  onSelect,
  selectedId,
  label,
  showChain = false,
}: {
  showChain?: boolean;
  rows: Transfer[];
  sortKey?: SortKey;
  sortDir?: "asc" | "desc";
  onSort?: (k: SortKey) => void;
  actions?: TransferRowActions;
  isBase?: (a: AddressInfo) => boolean;
  onSelect?: (t: Transfer) => void;
  selectedId?: string | null;
  label: string;
}) {
  const [relative, setRelative] = useState(false);
  const sortHead = (k: SortKey, text: string, right = false) => (
    <th scope="col" className={cn("h-8 whitespace-nowrap px-2", right ? "text-right" : "text-left")} aria-sort={sortKey === k ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
      {onSort ? (
        <button type="button" className="kit-colhead hover:text-text" onClick={() => onSort(k)}>
          {text}
          {sortKey === k ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
        </button>
      ) : (
        <span className="kit-colhead">{text}</span>
      )}
    </th>
  );
  return (
    <table className="kit-gtable w-full table-fixed border-collapse text-[13px]" aria-label={label}>
      <colgroup>
        {actions ? <col style={{ width: 36 }} /> : null}
        <col style={{ width: showChain ? 176 : 136 }} />
        <col />
        <col style={{ width: 16 }} />
        <col />
        <col style={{ width: 118 }} />
        <col style={{ width: 80 }} />
      </colgroup>
      <thead className="sticky top-0 z-[1]">
        <tr>
          {actions ? <th scope="col" className="w-9"><span className="sr-only">Actions</span></th> : null}
          <th scope="col" className="h-8 whitespace-nowrap px-2 text-left" aria-sort={sortKey === "time" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
            <span className="inline-flex items-center gap-1">
              {onSort ? (
                <button type="button" className="kit-colhead hover:text-text" onClick={() => onSort("time")}>
                  Time{sortKey === "time" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                </button>
              ) : (
                <span className="kit-colhead">Time</span>
              )}
              <button type="button" className="kit-mono kit-fade rounded-[3px] border border-border px-1 text-[11px] leading-[15px] text-faint hover:border-border-strong hover:text-text" onClick={() => setRelative((r) => !r)} aria-label={relative ? "Show absolute times" : "Show relative times"}>
                {relative ? "ABS" : "REL"}
              </button>
            </span>
          </th>
          <th scope="col" className="kit-colhead h-8 px-2 text-left">From</th>
          <th scope="col" className="w-4" aria-hidden />
          <th scope="col" className="kit-colhead h-8 px-2 text-left">To</th>
          {sortHead("value", "Amount", true)}
          {sortHead("usd", "USD", true)}
        </tr>
      </thead>
      <tbody>
        {rows.map((t) => {
          const dir = isBase ? transferDirection(t, isBase) : "none";
          const selected = selectedId === t.id;
          return (
            <tr key={`${t.chain}:${t.id}`} className={cn("kit-fade hover:bg-surface-2/60", selected && "bg-accent-soft", onSelect && "cursor-pointer")} onClick={onSelect ? () => onSelect(t) : undefined}>
              {actions ? (
                <td className="h-9 pl-2" onClick={(e) => e.stopPropagation()}>
                  <RowAction state={actions.stateOf(t)} label={`transfer ${t.txHash.slice(0, 10)}`} onAdd={() => actions.onAdd(t)} onRemove={actions.onRemove ? () => actions.onRemove!(t) : undefined} />
                </td>
              ) : null}
              <td className="kit-num h-9 overflow-hidden whitespace-nowrap px-2 text-xs text-muted">
                <span className="inline-flex items-center gap-1.5">
                  {showChain ? <ChainBadge chain={t.chain} /> : null}
                  <span title={t.blockTimestamp}>{relative ? formatRelative(t.blockTimestamp) : formatDateTime(t.blockTimestamp)}</span>
                </span>
              </td>
              <td className="h-9 max-w-0 px-2"><AddressChip info={t.from.ownerAddress ?? t.from} showHash={false} /></td>
              <td className="h-9 w-4 px-0 text-center">
                <ArrowRight aria-label={dir === "in" ? "incoming" : dir === "out" ? "outgoing" : "to"} className={cn("inline size-3.5", dir === "in" ? "text-in" : dir === "out" ? "text-out" : "text-faint")} />
              </td>
              <td className="h-9 max-w-0 px-2"><AddressChip info={t.to.ownerAddress ?? t.to} showHash={false} /></td>
              <td className={cn("kit-num h-9 truncate whitespace-nowrap px-2 text-right", dir === "in" && "text-in", dir === "out" && "text-out")}>
                <TokenAmount amount={t.amount} symbol={t.tokenSymbol ?? (t.tokenId === "native" ? (t.chain === "ethereum" ? "ETH" : "SOL") : null)} />
              </td>
              <td className="kit-num h-9 whitespace-nowrap px-2 pr-3 text-right"><UsdValue value={t.usd} /></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
