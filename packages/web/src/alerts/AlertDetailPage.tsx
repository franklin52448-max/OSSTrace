import * as Menu from "@radix-ui/react-dropdown-menu";
import { Bell, MoreVertical, Pause, Pencil, Play, RefreshCw, Trash2, Webhook } from "lucide-react";
import { useState } from "react";
import { useAlert, useAlertEvents, useAlertLimits, useDeleteAlert, useUpdateAlert } from "./api.ts";
import { isApiError } from "../kit/api.ts";
import { useEntities } from "../labels/api.ts";
import { useNotificationMethods } from "../settings/api.ts";
import { describeRule, noBackfillNote } from "./alertForm.ts";
import { useDocumentTitle } from "../kit/hooks.ts";
import { usePrefs } from "../settings/prefs.ts";
import { NotFound } from "../kit/NotFound.tsx";
import { Button, IconButton } from "../kit/Button.tsx";
import { ConfirmDialog } from "../kit/ConfirmDialog.tsx";
import { formatCount, formatRelative, formatTime } from "../kit/format.ts";
import { ErrorNotice, SkeletonRows } from "../kit/QueryState.tsx";
import { useToast } from "../kit/Toast.tsx";
import { AlertModal } from "./AlertModal.tsx";
import { EventHistory } from "./EventHistory.tsx";
import { RuleChips } from "./parts.tsx";

/** #alerts/<id>: title + actions, filter chips, then Recent matches. #alerts/<id>/edit opens the edit dialog. */
export function AlertDetailPage({ id, editing, onEditingChange }: { id: string; editing: boolean; onEditingChange: (editing: boolean) => void }) {
  const toast = useToast();
  const { timezone } = usePrefs();
  const rule = useAlert(id);
  const limits = useAlertLimits();
  const entities = useEntities();
  const methods = useNotificationMethods();
  const events = useAlertEvents(id);
  const update = useUpdateAlert();
  const del = useDeleteAlert();
  const [confirmDelete, setConfirmDelete] = useState(false);
  useDocumentTitle(rule.data?.name ?? "Alert");

  if (rule.isPending) return <SkeletonRows rows={6} className="kit-panel" />;
  if (rule.isError) {
    if (isApiError(rule.error, 404)) return <NotFound href="#alerts" label="Go to Alerts" />;
    return <ErrorNotice error={rule.error} onRetry={() => rule.refetch()} />;
  }
  const r = rule.data;
  const hooks = r.methodIds.map((m) => methods.data?.find((x) => x.id === m)).filter(Boolean);
  const setEnabled = (enabled: boolean) =>
    update.mutate({ id: r.id, enabled }, { onSuccess: () => toast.success(enabled ? "Resumed. Only new activity will fire." : "Paused."), onError: (e) => toast.error(e) });
  const item = "kit-fade flex h-8 cursor-pointer items-center gap-2 rounded-sm px-2 text-[13px] outline-none data-[highlighted]:bg-surface-2";

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[28px] font-semibold leading-tight tracking-[-0.02em]">{r.name}</h1>
          <p className="kit-mono mt-1.5 text-xs text-muted">
            <span className={r.enabled ? "text-accent" : "text-warn"}>{r.enabled ? "Watching" : "Paused"}</span>
            <span className="text-faint"> · </span>
            {formatCount(r.eventCount)} events
            <span className="text-faint"> · </span>
            <span title={r.lastTriggeredAt ? formatTime(r.lastTriggeredAt, timezone) : undefined}>last triggered {r.lastTriggeredAt ? formatRelative(r.lastTriggeredAt) : "never"}</span>
            <span className="text-faint"> · </span>
            created {formatTime(r.createdAt, timezone)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button icon={<Pencil aria-hidden className="size-3.5" />} onClick={() => onEditingChange(true)}>
            Edit
          </Button>
          <Button
            loading={update.isPending}
            icon={r.enabled ? <Pause aria-hidden className="size-3.5" /> : <Play aria-hidden className="size-3.5" />}
            onClick={() => setEnabled(!r.enabled)}
          >
            {r.enabled ? "Pause" : "Resume"}
          </Button>
          <Menu.Root>
            <Menu.Trigger aria-label="More actions" className="kit-fade inline-flex size-8 items-center justify-center rounded-sm border border-border bg-surface text-muted hover:border-border-strong hover:text-text data-[state=open]:bg-surface-2">
              <MoreVertical aria-hidden className="size-4" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content align="end" sideOffset={4} className="kit-overlay z-40 min-w-[168px] p-1">
                <Menu.Item className={`${item} text-danger`} onSelect={() => setConfirmDelete(true)}>
                  <Trash2 aria-hidden className="size-3.5" /> Delete alert
                </Menu.Item>
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-1.5 text-muted" title={`Delivery: in-app${hooks.length ? `, ${hooks.map((h) => h!.name).join(", ")}` : ""}`}>
          <Bell aria-hidden className="size-4" />
          {hooks.length ? <Webhook aria-hidden className="size-4" /> : null}
          <span className="sr-only">Delivery: in-app{hooks.length ? ` and ${hooks.length} webhook${hooks.length === 1 ? "" : "s"}` : ""}</span>
        </span>
        <span aria-hidden className="h-5 w-px bg-border" />
        <RuleChips rule={r} entities={entities.data} />
      </div>
      <p className="-mt-3 max-w-[90ch] text-[13px] text-muted">
        {describeRule(r, entities.data, methods.data)} {noBackfillNote(limits.data?.pollIntervalSec)}
      </p>

      <section aria-labelledby="matches-h">
        <h2 id="matches-h" className="mb-3 text-[18px] font-semibold tracking-[-0.01em]">
          Recent matches
        </h2>
        <div className="kit-panel">
          <div className="kit-panel-head">
            <p className="kit-panel-title">Transfers</p>
            <div className="ml-auto flex items-center gap-2">
              {events.data ? <span className="kit-num text-xs text-muted">{events.data.pages.flatMap((p) => p.events).length} shown</span> : null}
              <IconButton size="sm" label="Refresh matches" disabled={events.isFetching} onClick={() => events.refetch()}>
                <RefreshCw aria-hidden className={events.isFetching ? "size-3.5 animate-spin" : "size-3.5"} />
              </IconButton>
            </div>
          </div>
          <EventHistory alertId={r.id} entities={entities.data ?? []} methods={methods.data ?? []} />
        </div>
      </section>

      <AlertModal
        open={editing}
        onOpenChange={(o) => onEditingChange(o)}
        existing={r}
        onSaved={() => {
          toast.success("Alert saved.");
          onEditingChange(false);
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={(o) => {
          setConfirmDelete(o);
          if (!o) del.reset();
        }}
        title="Delete alert"
        body={<p>Delete "{r.name}"? It stops watching immediately. This cannot be undone.</p>}
        confirmLabel="Delete alert"
        pending={del.isPending}
        error={del.error}
        onConfirm={() =>
          del.mutate(r.id, {
            onSuccess: () => {
              toast.success(`Deleted "${r.name}".`);
              window.location.hash = "#alerts";
            },
          })
        }
      />
    </div>
  );
}
