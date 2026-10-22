import { History } from "lucide-react";
import type { AlertEvent, AlertTarget, Entity, NotificationMethod, Transfer } from "@osstrace/contract";
import { normalizeAddress } from "@osstrace/contract";
import { useAlertEvents } from "./api.ts";
import { usePrefs } from "../settings/prefs.ts";
import { AddressChip } from "../kit/AddressChip.tsx";
import { Button } from "../kit/Button.tsx";
import { cn } from "../kit/cn.ts";
import { CopyButton } from "../kit/CopyButton.tsx";
import { formatRelative, formatTime, shortAddress } from "../kit/format.ts";
import { EmptyState, ErrorNotice, SkeletonRows } from "../kit/QueryState.tsx";
import { Table, Td, Th, THead, Tr } from "../kit/Table.tsx";
import { TokenAmount } from "../kit/TokenAmount.tsx";
import { UsdValue } from "../kit/UsdValue.tsx";
import { FlowMark, TargetLabel } from "./parts.tsx";

/** Direction of the transfer as seen from the matched target. */
export function flowForTarget(t: Transfer, target: AlertTarget): "in" | "out" | "self" {
  let isFrom: boolean;
  let isTo: boolean;
  if (target.type === "entity") {
    isFrom = t.from.entity?.id === target.entityId;
    isTo = t.to.entity?.id === target.entityId;
  } else {
    const a = normalizeAddress(target.chain, target.address);
    const match = (x: Transfer["from"]) => normalizeAddress(t.chain, x.address) === a || (x.ownerAddress ? normalizeAddress(t.chain, x.ownerAddress.address) === a : false);
    isFrom = match(t.from);
    isTo = match(t.to);
  }
  if (isFrom && isTo) return "self";
  return isFrom ? "out" : "in";
}

const STATUS_CLASS: Record<AlertEvent["deliveries"][number]["status"], string> = { sent: "text-in", failed: "text-danger", skipped: "text-muted" };

function Deliveries({ event, methods }: { event: AlertEvent; methods: NotificationMethod[] }) {
  if (event.deliveries.length === 0) return <span className="text-muted">In-app only</span>;
  return (
    <ul className="flex flex-col gap-0.5">
      {event.deliveries.map((d) => {
        const m = methods.find((x) => x.id === d.methodId);
        return (
          <li key={d.methodId} title={d.detail} className="whitespace-nowrap text-xs">
            <span className="text-muted">{m?.name ?? (d.methodId === "in_app" ? "In-app" : "Removed method")}</span> <span className={STATUS_CLASS[d.status]}>{d.status}</span>
            {d.detail && d.status === "failed" ? <span className="ml-1 text-faint">({d.detail})</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

export function EventHistory({ alertId, entities, methods }: { alertId: string; entities: Entity[]; methods: NotificationMethod[] }) {
  const q = useAlertEvents(alertId);
  const { timezone } = usePrefs();
  if (q.isPending) return <SkeletonRows rows={5} />;
  if (q.isError) return <ErrorNotice className="m-3" error={q.error} onRetry={() => q.refetch()} />;
  const events = q.data.pages.flatMap((p) => p.events);
  if (events.length === 0) {
    return <EmptyState icon={<History />} title="No events yet." body="This rule has not fired. It only reports transfers made after it was saved or last enabled." />;
  }
  const go = (chain: Transfer["chain"], address: string) => {
    window.location.hash = `#address/${chain}/${encodeURIComponent(address)}`;
  };

  return (
    <div>
      <Table label="Alert events">
        <THead>
          <tr>
            <Th>Time</Th>
            <Th>Matched</Th>
            <Th>Flow</Th>
            <Th num>Amount</Th>
            <Th num>USD</Th>
            <Th>From</Th>
            <Th>To</Th>
            <Th>Tx</Th>
            <Th>Delivery</Th>
          </tr>
        </THead>
        <tbody>
          {events.map((ev) => {
            const t = ev.transfer;
            const flow = flowForTarget(t, ev.matchedTarget);
            return (
              <Tr key={ev.id}>
                <Td className="kit-num whitespace-nowrap text-muted">
                  <span title={`Block time ${formatTime(t.blockTimestamp, timezone)} · detected ${formatTime(ev.createdAt, timezone)}`}>{formatRelative(t.blockTimestamp)}</span>
                </Td>
                <Td className="max-w-48">
                  <TargetLabel target={ev.matchedTarget} entities={entities} />
                </Td>
                <Td className={cn("text-xs")}>
                  <FlowMark flow={flow} />
                </Td>
                <Td num>
                  <TokenAmount amount={t.amount} symbol={t.tokenSymbol} />
                </Td>
                <Td num>
                  <UsdValue value={t.usd} />
                </Td>
                <Td className="max-w-44">
                  <AddressChip info={t.from} onClick={() => go(t.chain, t.from.address)} />
                </Td>
                <Td className="max-w-44">
                  <AddressChip info={t.to} onClick={() => go(t.chain, t.to.address)} />
                </Td>
                <Td className="whitespace-nowrap">
                  <span className="inline-flex items-center gap-1">
                    <span className="kit-mono text-xs text-muted" title={t.txHash}>
                      {shortAddress(t.txHash, 6, 4)}
                    </span>
                    <CopyButton value={t.txHash} label="Copy transaction hash" />
                  </span>
                </Td>
                <Td>
                  <Deliveries event={ev} methods={methods} />
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
      <div className="flex h-10 items-center gap-3 border-t border-border bg-surface-2 px-4 text-xs text-muted">
        <span className="kit-num">{events.length} shown</span>
        {q.hasNextPage ? (
          <Button size="sm" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
            Load more
          </Button>
        ) : (
          <span>End of history</span>
        )}
        <a href="#alerts/inbox" className="ml-auto text-accent hover:underline">
          Inbox
        </a>
      </div>
    </div>
  );
}
