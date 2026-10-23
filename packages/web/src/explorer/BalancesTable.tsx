import type { Chain } from "@osstrace/contract";
import { Coins } from "lucide-react";
import { useState } from "react";
import { useBalances } from "../kit/address.ts";
import { usePrefs } from "../settings/prefs.ts";
import { formatTime, formatUsd, shortAddress } from "../kit/format.ts";
import { EmptyState, ErrorNotice, SkeletonRows } from "../kit/QueryState.tsx";
import { Table, Td, Th, THead, Tr } from "../kit/Table.tsx";
import { TokenAmount } from "../kit/TokenAmount.tsx";
import { TokenLogo } from "../kit/TokenLogo.tsx";
import { UsdValue } from "../kit/UsdValue.tsx";

export function BalancesTable({ chain, address }: { chain: Chain; address: string }) {
  const q = useBalances(chain, address);
  const { timezone } = usePrefs();
  const [showUnpriced, setShowUnpriced] = useState(false);
  const [view, setView] = useState<"portfolio" | "chain">("portfolio");
  const all = q.data?.balances ?? [];
  const unpriced = all.filter((b) => b.usd == null).length;
  // Unpriced tokens (often airdropped spam) are hidden by default but counted and one click away; nothing is dropped silently.
  const rows = showUnpriced ? all : all.filter((b) => b.usd != null);
  return (
    <section aria-labelledby="balances-h" className="kit-panel">
      <div className="kit-panel-head pl-0">
        <h2 id="balances-h" className="sr-only">
          Holdings
        </h2>
        <div role="tablist" aria-label="Holdings view" className="flex self-stretch">
          {(
            [
              ["portfolio", "Portfolio"],
              ["chain", "Holdings by chain"],
            ] as const
          ).map(([v, l]) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} data-state={view === v ? "active" : "inactive"} onClick={() => setView(v)} className="kit-ptab">
              {l}
              {v === "portfolio" && q.data ? <span className="kit-num font-normal text-muted">{rows.length}</span> : null}
            </button>
          ))}
        </div>
        {q.data ? (
          <p className="kit-mono ml-auto text-xs text-muted" title={unpriced > 0 ? `${unpriced} tokens without a price are not in the total` : undefined}>
            fetched {formatTime(q.data.fetchedAt, timezone)}
          </p>
        ) : null}
      </div>
      {q.isPending ? (
        <SkeletonRows rows={4} />
      ) : q.isError ? (
        <ErrorNotice error={q.error} onRetry={() => q.refetch()} title="Could not load balances" className="m-3" />
      ) : all.length === 0 ? (
        <EmptyState icon={<Coins />} title="No token balances." body="The provider returned no native or token balance for this address." />
      ) : view === "chain" ? (
        <Table label="Holdings by chain">
          <THead>
            <tr>
              <Th>Network</Th>
              <Th num>Priced tokens</Th>
              <Th num>Without a price</Th>
              <Th num>USD</Th>
            </tr>
          </THead>
          <tbody>
            <Tr>
              <Td>
                <span className="font-medium">{chain === "ethereum" ? "Ethereum" : "Solana"}</span>
              </Td>
              <Td num>{all.length - unpriced}</Td>
              <Td num className="text-muted">
                {unpriced}
              </Td>
              <Td num>
                <UsdValue value={q.data?.totalUsd ?? null} />
              </Td>
            </Tr>
          </tbody>
        </Table>
      ) : (
        <div className="max-h-[420px] overflow-y-auto">
          {rows.length === 0 ? <p className="px-4 py-3 text-[13px] text-muted">None of this address's tokens has a price source.</p> : null}
          <Table label="Token balances">
            <THead>
              <tr>
                <Th>Asset</Th>
                <Th num>Holdings</Th>
                <Th num>Price</Th>
                <Th num>Value</Th>
              </tr>
            </THead>
            <tbody>
              {rows.map((b) => (
                <Tr key={b.tokenId}>
                  <Td>
                    <span className="flex items-center gap-2.5">
                      <TokenLogo chain={chain} tokenId={b.tokenId} symbol={b.symbol} logoUrl={b.logoUrl} />
                      <span className="kit-mono font-medium">{b.symbol ?? (b.tokenId === "native" ? (chain === "ethereum" ? "ETH" : "SOL") : "Unknown token")}</span>
                      <span className="text-xs text-faint">{b.name ?? (b.tokenId === "native" ? "" : shortAddress(b.tokenId, 6, 4))}</span>
                    </span>
                  </Td>
                  <Td num>
                    <TokenAmount amount={b.amount} />
                  </Td>
                  <Td num className="text-muted">
                    {b.price == null ? <span title="No price source for this token">—</span> : <span title={b.priceSource ? `Price source: ${b.priceSource}` : undefined}>{formatUsd(b.price)}</span>}
                  </Td>
                  <Td num>
                    <UsdValue value={b.usd} />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
      {unpriced > 0 && q.data && view === "portfolio" ? (
        <div className="flex h-10 items-center border-t border-border bg-surface-2 px-4">
          <button type="button" className="text-xs font-medium text-accent underline-offset-4 hover:underline" onClick={() => setShowUnpriced((v) => !v)} aria-expanded={showUnpriced}>
            {showUnpriced ? "Hide tokens without a price" : `Show ${unpriced} token${unpriced === 1 ? "" : "s"} without a price`}
          </button>
        </div>
      ) : null}
    </section>
  );
}
