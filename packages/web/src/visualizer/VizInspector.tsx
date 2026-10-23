import { NATIVE_SYMBOLS, type AddressInfo, type Transfer } from "@osstrace/contract";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { explorerTxUrl } from "../explorers.ts";
import { AddressChip } from "../kit/AddressChip.tsx";
import { IconButton } from "../kit/Button.tsx";
import { ChainBadge } from "../kit/ChainBadge.tsx";
import { cn } from "../kit/cn.ts";
import { CopyButton } from "../kit/CopyButton.tsx";
import { EmptyState } from "../kit/QueryState.tsx";
import { TokenAmount } from "../kit/TokenAmount.tsx";
import { UsdValue } from "../kit/UsdValue.tsx";
import { pageCount, paginate, transferDirection } from "../panels/model.ts";
import { formatDateTime, PanelStrip, Pager, SegTabs } from "../panels/parts.tsx";
import { TransferTable } from "../panels/TransferTable.tsx";

const PAGE = 25;

/** The canvas's own rows (client-side paging over the loaded transfers) plus the clicked transfer's details. */
export function VizInspector({ rows, isBase, selected, onSelect, onClose }: { rows: Transfer[]; isBase: (a: AddressInfo) => boolean; selected: Transfer | null; onSelect: (t: Transfer | null) => void; onClose: () => void }) {
  const [flow, setFlow] = useState<"all" | "in" | "out" | "self">("all");
  const [page, setPage] = useState(0);
  const filtered = useMemo(() => (flow === "all" ? rows : rows.filter((t) => transferDirection(t, isBase) === flow)), [rows, flow, isBase]);
  useEffect(() => setPage(0), [flow, rows]);
  const pages = pageCount(filtered.length, PAGE);
  return (
    <aside aria-label="Transfers on the canvas" className="pointer-events-auto flex h-full w-[min(560px,calc(100vw-360px))] min-w-[340px] flex-col gap-3" data-canvas-scroll-region>
      <div className={cn("kit-overlay flex min-h-0 flex-col overflow-hidden", selected ? "flex-[3_1_0]" : "flex-1")}>
      <header className="shrink-0">
        <PanelStrip
          aside={
            <>
              <span className="kit-num text-xs text-faint">{filtered.length.toLocaleString("en-US")} on canvas</span>
              <IconButton size="sm" label="Hide panels" onClick={onClose}><X aria-hidden className="size-3.5" /></IconButton>
            </>
          }
        >
          <SegTabs variant="tabs" label="Direction" value={flow} onChange={setFlow} items={[{ value: "all", label: "Transfers" }, { value: "in", label: "In" }, { value: "out", label: "Out" }, { value: "self", label: "Self" }]} />
        </PanelStrip>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {filtered.length === 0 ? <EmptyState title="No transfers on the canvas." /> : <TransferTable rows={paginate(filtered, Math.min(page, pages - 1), PAGE)} label="Canvas transfers" isBase={isBase} onSelect={(t) => onSelect(selected?.id === t.id ? null : t)} selectedId={selected?.id} />}
      </div>
      <div className="flex h-9 shrink-0 items-center justify-end border-t border-border px-3">
        <Pager page={Math.min(page, pages - 1)} pages={pages} onPage={setPage} label="Canvas transfer pages" />
      </div>
      </div>
      {selected ? <Details t={selected} isBase={isBase} onClose={() => onSelect(null)} /> : null}
    </aside>
  );
}

function Details({ t, isBase, onClose }: { t: Transfer; isBase: (a: AddressInfo) => boolean; onClose: () => void }) {
  const dir = transferDirection(t, isBase);
  // Ethereum/Solana keep the explorers this view has always linked; every other chain uses its own
  // (explorers.ts) -- never a fall-through to Solana's, which a third ternary arm would have been.
  const explorer =
    t.chain === "ethereum" ? `https://eth.blockscout.com/tx/${t.txHash}` : t.chain === "solana" ? `https://explorer.solana.com/tx/${t.txHash}` : explorerTxUrl(t.chain, t.txHash);
  return (
    <section aria-label="Transfer details" className="kit-overlay flex-[2_1_0] overflow-auto">
      <header className="flex h-10 items-center gap-2 border-b border-border bg-surface-2 px-3">
        <h3 className="kit-sect-h">Transfer</h3>
        <ChainBadge chain={t.chain} long />
        <IconButton size="sm" label="Close details" onClick={onClose} className="ml-auto"><X aria-hidden className="size-3.5" /></IconButton>
      </header>
      <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-2 px-3 py-3 text-[13px]">
        <dt className="text-xs text-muted">Time</dt>
        <dd className="kit-num">{formatDateTime(t.blockTimestamp)} <span className="text-faint">block {t.blockNumber.toLocaleString("en-US")}</span></dd>
        <dt className="text-xs text-muted">From</dt>
        <dd className="min-w-0"><AddressChip info={t.from.ownerAddress ?? t.from} /></dd>
        <dt className="text-xs text-muted">To</dt>
        <dd className="min-w-0"><AddressChip info={t.to.ownerAddress ?? t.to} /></dd>
        <dt className="text-xs text-muted">Amount</dt>
        <dd className={cn("kit-num", dir === "in" && "text-in", dir === "out" && "text-out")}><TokenAmount amount={t.amount} symbol={t.tokenSymbol ?? (t.tokenId === "native" ? NATIVE_SYMBOLS[t.chain] : null)} /></dd>
        <dt className="text-xs text-muted">USD</dt>
        <dd className="kit-num"><UsdValue value={t.usd} />{t.priceSource ? <span className="ml-2 text-xs text-faint">{t.priceSource}</span> : null}</dd>
        <dt className="text-xs text-muted">Transaction</dt>
        <dd className="flex min-w-0 items-center gap-1">
          <a href={explorer} target="_blank" rel="noreferrer noopener" className="kit-mono truncate text-xs text-accent underline">{t.txHash}</a>
          <CopyButton value={t.txHash} label="Copy transaction hash" />
        </dd>
      </dl>
    </section>
  );
}
