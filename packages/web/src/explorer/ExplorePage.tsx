import { CHAINS, normalizeAddress, type Chain, type CreateTraceRequest, type Label } from "@osstrace/contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bell, Network, Pencil, RefreshCw, UserPlus, Waypoints } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useAddressInfo, useBalances } from "../kit/address.ts";
import { api } from "../kit/api.ts";
import { useLabels } from "../labels/api.ts";
import { useDocumentTitle } from "../kit/hooks.ts";
import { CHAIN_NAMES, validateAddress } from "../kit/validation.ts";
import { NotFound } from "../kit/NotFound.tsx";
import { Button, buttonClass, IconButton } from "../kit/Button.tsx";
import { ChainBadge } from "../kit/ChainBadge.tsx";
import { Chip } from "../kit/Chip.tsx";
import { CopyButton } from "../kit/CopyButton.tsx";
import { addressDisplayName, formatUsd, shortAddress } from "../kit/format.ts";
import { ErrorNotice } from "../kit/QueryState.tsx";
import { TagChip } from "../kit/TagChip.tsx";
import { useToast } from "../kit/Toast.tsx";
import { CounterpartiesPanel, TransfersPanel } from "../panels/index.ts";
import { LabelDialog } from "../labels/LabelDialog.tsx";
import { BalancesTable } from "./BalancesTable.tsx";

export function ExplorePage({ chain: rawChain, addr }: { chain: string; addr: string }) {
  const chain = rawChain as Chain;
  if (!CHAINS.includes(chain)) return <NotFound />;
  const invalid = validateAddress(chain, addr);
  if (invalid) {
    return (
      <div className="mx-auto w-full max-w-[var(--trace-page-max)] px-[var(--trace-page-gutter)] py-8">
        <h1 className="text-[26px] font-semibold tracking-[-0.02em]">Not a valid address</h1>
        <p className="kit-panel mt-4 px-4 py-4 text-[13px] text-muted">
          <span className="kit-mono break-all text-text">{addr}</span> on {CHAIN_NAMES[chain]}: {invalid}
        </p>
      </div>
    );
  }
  return <AddressView key={`${chain}:${addr}`} chain={chain} address={addr} />;
}

/** Address page: identity header line + holdings figure, Holdings and Top counterparties side by side, Transfers below. */
function AddressView({ chain, address }: { chain: Chain; address: string }) {
  const info = useAddressInfo(chain, address);
  const balances = useBalances(chain, address);
  const toast = useToast();
  const qc = useQueryClient();
  const transfersRef = useRef<HTMLElement>(null);
  const [labelOpen, setLabelOpen] = useState(false);
  const [counterparty, setCounterparty] = useState<string | undefined>(undefined);
  const data = info.data;
  const named = !!(data?.entity || data?.label);
  useDocumentTitle(named && data ? addressDisplayName(data) : shortAddress(address));

  // The full Label (for editing) comes from the labels list; AddressInfo only carries a LabelRef.
  const labelQ = useLabels({ chain, q: address, limit: 5 });
  const existing: Label | null = labelQ.data?.labels.find((l) => normalizeAddress(chain, l.address) === normalizeAddress(chain, address)) ?? null;

  const newTrace = useMutation({
    mutationFn: (body: CreateTraceRequest) => api<{ id: string }>("/traces", { method: "POST", json: body }),
    onSuccess: ({ id }) => (window.location.hash = `#trace/doc/${id}`),
    onError: (e) => toast.error(e),
  });
  const base = `${chain}:${address}`;
  const initial = (data?.entity?.name ?? data?.label?.name ?? address.replace(/^0x/, "")).slice(0, 1).toUpperCase();
  const unpriced = balances.data?.balances.filter((b) => b.usd == null).length ?? 0;

  return (
    <div className="mx-auto flex w-full max-w-[var(--trace-page-max)] flex-col gap-5 px-[var(--trace-page-gutter)] py-6">
      <header className="flex flex-wrap items-start gap-x-6 gap-y-4">
        <span aria-hidden className="inline-flex size-[72px] shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface text-[28px] font-semibold text-muted">
          {initial}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h1 className="flex min-w-0 items-baseline gap-2 text-[24px] font-semibold leading-tight tracking-[-0.02em]">
              {data?.entity ? (
                <>
                  <a href={`#labels/entities?entity=${encodeURIComponent(data.entity.id)}`} className="truncate hover:text-accent">
                    {data.entity.name}
                  </a>
                  <span className="text-faint">:</span>
                </>
              ) : null}
              <span className="truncate">{data?.label?.name ?? (data?.entity ? "" : "Unlabeled address")}</span>
              <span className="kit-mono shrink-0 text-[16px] font-normal text-muted" title={address}>
                ({shortAddress(address, 6, 4)})
              </span>
            </h1>
            <span className="flex items-center gap-0.5">
              <IconButton size="sm" label={existing ? "Rename label" : "Label this address"} disabled={labelQ.isPending} onClick={() => setLabelOpen(true)}>
                <Pencil aria-hidden className="size-3.5" />
              </IconButton>
              <IconButton size="sm" label="Add to entity" disabled={labelQ.isPending} onClick={() => setLabelOpen(true)}>
                <UserPlus aria-hidden className="size-3.5" />
              </IconButton>
              <CopyButton value={address} label="Copy address" />
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="kit-num text-[28px] font-semibold leading-tight tracking-[-0.02em]" title={unpriced ? `${unpriced} tokens without a price are not in this total` : "Priced holdings"}>
              {balances.data ? formatUsd(balances.data.totalUsd) : balances.isError ? "—" : <span className="kit-skeleton inline-block h-6 w-32 align-middle" />}
            </span>
            <span className="text-xs text-muted">priced holdings{unpriced ? `, ${unpriced} unpriced tokens not counted` : ""}</span>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs">
            <ChainBadge chain={chain} long />
            {data?.isProgram ? <Chip k="Program" tone="warn" /> : null}
            {data?.entity?.type ? <Chip k="Type">{data.entity.type}</Chip> : null}
            {(data?.tags ?? []).map((t) => (
              <TagChip key={t.id} tag={t} />
            ))}
            {data?.ownerAddress ? (
              <span className="text-muted">
                token account of{" "}
                <a href={`#address/${data.ownerAddress.chain}/${encodeURIComponent(data.ownerAddress.address)}`} className="kit-mono text-accent hover:underline">
                  {addressDisplayName(data.ownerAddress)}
                </a>
              </span>
            ) : null}
            {data && !named && !(data.tags ?? []).length ? <span className="text-faint">Not in your label set. Labels are private to your account.</span> : null}
            {data?.label?.note ? <span className="text-muted">{data.label.note}</span> : null}
          </div>
          {info.isError ? <ErrorNotice className="mt-3" error={info.error} onRetry={() => info.refetch()} /> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            icon={<Waypoints aria-hidden className="size-3.5" />}
            loading={newTrace.isPending}
            onClick={() => newTrace.mutate({ initialAddress: address, initialChain: chain })}
          >
            Trace address
          </Button>
          <a href={`#graph/scratch?base=${encodeURIComponent(base)}`} className={buttonClass()}>
            <Network aria-hidden className="size-3.5" /> Visualize
          </a>
          <a href={`#alerts/new?chain=${chain}&address=${encodeURIComponent(address)}`} className={buttonClass()}>
            <Bell aria-hidden className="size-3.5" /> Create alert
          </a>
        </div>
      </header>

      <div className="grid items-start gap-4 xl:grid-cols-2">
        <BalancesTable chain={chain} address={address} />
        <Block title="Top counterparties">
          <CounterpartiesPanel
            chain={chain}
            address={address}
            title="Top counterparties"
            className="max-h-[460px]"
            onSelectRow={(row) => {
              // Address rows narrow the transfers block; entity rows have no single address to filter on.
              const key = row && row.kind === "address" ? row.key : undefined;
              setCounterparty(key);
              if (key) transfersRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            selectedKey={counterparty ?? null}
          />
        </Block>
      </div>

      <section ref={transfersRef} aria-label="Transfers" className="kit-panel scroll-mt-4">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          {counterparty ? (
            <Chip k="With" tone="accent" onRemove={() => setCounterparty(undefined)} removeLabel="Show all transfers">
              {shortAddress(bareAddress(counterparty), 6, 6)}
            </Chip>
          ) : (
            <span className="text-xs text-muted">All counterparties. Select a counterparty above to narrow.</span>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            icon={<RefreshCw aria-hidden className="size-3" />}
            onClick={() => {
              void qc.invalidateQueries({ queryKey: ["graph", "transfers"] });
              void balances.refetch();
            }}
          >
            Refresh transfers
          </Button>
        </div>
        <TransfersPanel chain={chain} address={address} counterparty={counterparty} title="Transfers" />
      </section>

      <LabelDialog open={labelOpen} onOpenChange={setLabelOpen} label={existing} initial={{ chain, address }} />
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="kit-panel">
      {children}
    </section>
  );
}

/** Panel row keys are `chain:address`; strip the chain for display. */
const bareAddress = (key: string) => key.slice(key.indexOf(":") + 1);
