import type { NotificationMethod } from "@osstrace/contract";
import { Bell, Plus, Trash2, Webhook } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useAlerts, useInbox } from "./api.ts";
import { useDeleteNotificationMethod, useNotificationMethods, useUpdateNotificationMethod } from "../settings/api.ts";
import { useDocumentTitle } from "../kit/hooks.ts";
import { Button, IconButton } from "../kit/Button.tsx";
import { cn } from "../kit/cn.ts";
import { ConfirmDialog } from "../kit/ConfirmDialog.tsx";
import { formatCount } from "../kit/format.ts";
import { ErrorNotice, SkeletonRows } from "../kit/QueryState.tsx";
import { Switch } from "../kit/Switch.tsx";
import { useToast } from "../kit/Toast.tsx";
import { WebhookDialog } from "../settings/WebhookDialog.tsx";

const HOUR = 3_600_000;
const MONTH = 30 * 24 * HOUR;

/** #alerts/manage: delivery usage (from your notifications) and delivery methods with the rules that use each one. */
export function ManagePage() {
  useDocumentTitle("Manage alerts");
  const alerts = useAlerts();
  const methods = useNotificationMethods();
  const inbox = useInbox(false);
  const update = useUpdateNotificationMethod();
  const del = useDeleteNotificationMethod();
  const toast = useToast();
  const [window_, setWindow] = useState<"hour" | "month">("hour");
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<NotificationMethod | null>(null);

  const usage = useMemo(() => {
    const items = inbox.data?.pages.flatMap((p) => p.notifications) ?? [];
    const span = window_ === "hour" ? HOUR : MONTH;
    const since = Date.now() - span;
    const n = items.filter((x) => Date.parse(x.createdAt) >= since).length;
    const oldest = items.at(-1);
    // If more pages exist and even the oldest loaded item is inside the window, the true count is higher.
    const lowerBound = !!inbox.hasNextPage && !!oldest && Date.parse(oldest.createdAt) >= since;
    return { n, lowerBound };
  }, [inbox.data, inbox.hasNextPage, window_]);

  const ruleCount = (methodId: string) => (alerts.data ?? []).filter((r) => r.methodIds.includes(methodId)).length;
  const webhooks = (methods.data ?? []).filter((m) => m.kind === "webhook");

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">Manage alerts</h1>

      <section aria-labelledby="m-usage">
        <div className="mb-3 flex items-center gap-3">
          <h2 id="m-usage" className="mr-auto text-[18px] font-semibold tracking-[-0.01em]">
            Usage
          </h2>
          <div role="group" aria-label="Usage window" className="inline-flex h-8 items-center rounded-sm border border-border bg-surface p-0.5">
            {(
              [
                ["hour", "Hourly"],
                ["month", "Monthly"],
              ] as const
            ).map(([v, l]) => (
              <button
                key={v}
                type="button"
                aria-pressed={window_ === v}
                onClick={() => setWindow(v)}
                className={cn("kit-fade h-full rounded-[4px] px-3 text-xs font-medium", window_ === v ? "bg-surface-3 text-text" : "text-muted hover:text-text")}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
        <div className="kit-panel divide-y divide-border">
          <UsageRow icon={<Bell aria-hidden className="size-4" />} name="In-app inbox and bell">
            {inbox.isPending ? (
              <span className="text-muted">Loading</span>
            ) : inbox.isError ? (
              <span className="text-danger">Could not load notifications</span>
            ) : (
              <>
                <span className="kit-num text-[15px] font-semibold">
                  {usage.lowerBound ? "at least " : ""}
                  {formatCount(usage.n)}
                </span>
                <span className="text-muted"> notifications in the last {window_ === "hour" ? "hour" : "30 days"}</span>
              </>
            )}
          </UsageRow>
          <UsageRow icon={<Webhook aria-hidden className="size-4" />} name="Webhooks">
            <span className="text-muted">Per-delivery counts are not recorded yet; see each rule's event history for delivery status.</span>
          </UsageRow>
        </div>
      </section>

      <section aria-labelledby="m-methods">
        <div className="mb-3 flex items-center gap-3">
          <h2 id="m-methods" className="mr-auto text-[18px] font-semibold tracking-[-0.01em]">
            Delivery methods
          </h2>
          <Button icon={<Plus aria-hidden className="size-3.5" />} onClick={() => setAdding(true)}>
            Webhook
          </Button>
        </div>
        <div className="kit-panel">
          <p className="kit-colhead border-b border-border px-4 py-2.5">Rules always deliver in-app; webhooks are chosen per rule</p>
          {methods.isPending ? (
            <SkeletonRows rows={2} />
          ) : methods.isError ? (
            <ErrorNotice className="m-3" error={methods.error} onRetry={() => methods.refetch()} />
          ) : (
            <ul className="divide-y divide-border">
              <li className="flex items-center gap-3 px-4 py-3">
                <Bell aria-hidden className="size-4 text-muted" />
                <span className="font-medium">In-app</span>
                <span className="rounded-[4px] border border-accent/40 bg-accent-soft px-1.5 text-[11px] font-medium text-accent">Default</span>
                <span className="kit-num ml-auto text-xs text-muted">{formatCount(alerts.data?.length ?? 0)} rules</span>
              </li>
              {webhooks.map((m) => {
                const n = ruleCount(m.id);
                return (
                  <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <Webhook aria-hidden className="size-4 text-muted" />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{m.name}</p>
                      <p className="kit-mono truncate text-xs text-faint" title={m.url}>
                        {m.url}
                      </p>
                    </div>
                    <span className="kit-num text-xs text-muted">
                      {formatCount(n)} rule{n === 1 ? "" : "s"}
                    </span>
                    <Switch
                      checked={m.enabled}
                      disabled={update.isPending}
                      label={`${m.enabled ? "Disable" : "Enable"} ${m.name}`}
                      onCheckedChange={(enabled) => update.mutate({ id: m.id, enabled }, { onError: (e) => toast.error(e) })}
                    />
                    <IconButton size="sm" label={`Delete ${m.name}`} onClick={() => setDeleting(m)}>
                      <Trash2 aria-hidden className="size-3.5" />
                    </IconButton>
                  </li>
                );
              })}
              {webhooks.length === 0 ? <li className="px-4 py-3 text-[13px] text-muted">No webhooks yet. Email, Telegram and Slack are not available in this version.</li> : null}
            </ul>
          )}
        </div>
      </section>

      <WebhookDialog open={adding} onOpenChange={setAdding} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => {
          if (!o) {
            setDeleting(null);
            del.reset();
          }
        }}
        title="Delete webhook"
        confirmDisabled={!!deleting && ruleCount(deleting.id) > 0}
        body={
          deleting && ruleCount(deleting.id) > 0 ? (
            <p>
              <span className="font-medium text-text">{deleting.name}</span> is used by {ruleCount(deleting.id)} rule{ruleCount(deleting.id) === 1 ? "" : "s"}. Remove it from those
              rules first (edit each rule, step 2), then delete it.
            </p>
          ) : (
            <p>
              Delete <span className="font-medium text-text">{deleting?.name}</span>? No rule uses it.
            </p>
          )
        }
        confirmLabel="Delete webhook"
        pending={del.isPending}
        error={del.error}
        onConfirm={() =>
          deleting &&
          del.mutate(deleting.id, {
            onSuccess: () => {
              toast.success("Webhook deleted");
              setDeleting(null);
            },
          })
        }
      />
    </div>
  );
}

function UsageRow({ icon, name, children }: { icon: ReactNode; name: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-4 text-[13px]">
      <span className="flex w-56 items-center gap-2 font-medium">
        <span className="text-muted">{icon}</span>
        {name}
      </span>
      <span>{children}</span>
    </div>
  );
}
