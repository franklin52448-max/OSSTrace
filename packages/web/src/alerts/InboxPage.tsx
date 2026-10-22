import type { Notification } from "@osstrace/contract";
import { Inbox as InboxIcon } from "lucide-react";
import { useState } from "react";
import { useInbox, useMarkRead } from "./api.ts";
import { useDocumentTitle } from "../kit/hooks.ts";
import { usePrefs } from "../settings/prefs.ts";
import { AddressChip } from "../kit/AddressChip.tsx";
import { Button } from "../kit/Button.tsx";
import { ChainBadge } from "../kit/ChainBadge.tsx";
import { cn } from "../kit/cn.ts";
import { formatRelative, formatTime } from "../kit/format.ts";
import { EmptyState, ErrorNotice, SkeletonRows } from "../kit/QueryState.tsx";
import { TokenAmount } from "../kit/TokenAmount.tsx";
import { UsdValue } from "../kit/UsdValue.tsx";
import { useToast } from "../kit/Toast.tsx";

export function InboxPage() {
  useDocumentTitle("Inbox");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const inbox = useInbox(unreadOnly);
  const mark = useMarkRead();
  const toast = useToast();
  const { timezone } = usePrefs();
  const items = inbox.data?.pages.flatMap((p) => p.notifications) ?? [];
  const unreadCount = inbox.data?.pages[0]?.unreadCount ?? 0;

  const markOne = (n: Notification) => {
    if (!n.read) mark.mutate({ ids: [n.id] });
  };
  const go = (chain: string, address: string) => {
    window.location.hash = `#address/${chain}/${encodeURIComponent(address)}`;
  };

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">Inbox</h1>
      <div className="kit-panel">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2.5">
        <div role="group" aria-label="Filter notifications" className="inline-flex h-8 items-center rounded-sm border border-border bg-surface-2 p-0.5">
          {[
            { v: false, label: "All" },
            { v: true, label: "Unread" },
          ].map((o) => (
            <button
              key={o.label}
              type="button"
              aria-pressed={unreadOnly === o.v}
              onClick={() => setUnreadOnly(o.v)}
              className={cn("kit-fade h-full rounded-[4px] px-3 text-xs font-medium", unreadOnly === o.v ? "bg-surface-3 text-text shadow-[0_1px_0_rgba(0,0,0,0.15)]" : "text-muted hover:text-text")}
            >
              {o.label}
            </button>
          ))}
        </div>
        <span className="kit-num text-xs text-muted">{unreadCount} unread</span>
        <Button
          size="sm"
          className="ml-auto"
          disabled={unreadCount === 0}
          loading={mark.isPending}
          onClick={() => mark.mutate({ all: true }, { onSuccess: () => toast.success("All notifications marked read."), onError: (e) => toast.error(e) })}
        >
          Mark all read
        </Button>
      </div>

      {inbox.isPending ? (
        <SkeletonRows rows={6} />
      ) : inbox.isError ? (
        <ErrorNotice className="m-3" error={inbox.error} onRetry={() => inbox.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<InboxIcon />}
          title={unreadOnly ? "Nothing unread." : "No notifications yet."}
          body={unreadOnly ? "Every notification has been read." : "When a rule fires, it shows up here and on the bell."}
        />
      ) : (
        <>
          <ul aria-label="Notifications" className="divide-y divide-border">
            {items.map((n) => {
              const t = n.transfer;
              return (
                <li key={n.id} className={cn("kit-fade flex items-start gap-3 px-4 py-3 hover:bg-surface-2", !n.read && "bg-accent-soft")}>
                  <span aria-hidden className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", n.read ? "bg-transparent" : "bg-accent")} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className={cn("font-medium", n.read && "text-muted")}>{n.alertName}</span>
                      {!n.read ? <span className="sr-only">(unread)</span> : null}
                      <ChainBadge chain={t.chain} />
                      <TokenAmount amount={t.amount} symbol={t.tokenSymbol} />
                      <span className="text-muted">
                        <UsdValue value={t.usd} />
                      </span>
                    </div>
                    <div className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs text-muted">
                      <AddressChip info={t.from} />
                      <span>to</span>
                      <AddressChip info={t.to} />
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1 text-xs">
                    <span className="kit-num text-faint" title={formatTime(n.createdAt, timezone)}>
                      {formatRelative(n.createdAt)}
                    </span>
                    <div className="flex gap-3">
                      <button type="button" onClick={() => { markOne(n); go(t.chain, t.from.address); }} className="text-accent hover:underline">
                        Sender
                      </button>
                      <button type="button" onClick={() => { markOne(n); go(t.chain, t.to.address); }} className="text-accent hover:underline">
                        Recipient
                      </button>
                      {!n.read ? (
                        <button type="button" onClick={() => markOne(n)} className="text-muted hover:text-text">
                          Mark read
                        </button>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="flex h-10 items-center gap-3 border-t border-border bg-surface-2 px-4 text-xs text-muted">
            <span className="kit-num">{items.length} shown</span>
            {inbox.hasNextPage ? (
              <Button size="sm" loading={inbox.isFetchingNextPage} onClick={() => inbox.fetchNextPage()}>
                Load more
              </Button>
            ) : null}
          </div>
        </>
      )}
      </div>
    </div>
  );
}
