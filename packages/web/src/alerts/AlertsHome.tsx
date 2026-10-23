import type { AlertRule } from "@osstrace/contract";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { Bell, LayoutGrid, List, MoreVertical, Pause, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useAlertLimits, useAlerts, useDeleteAlert, useUnreadCount, useUpdateAlert } from "./api.ts";
import { useEntities } from "../labels/api.ts";
import { useNotificationMethods } from "../settings/api.ts";
import { usePrefs } from "../settings/prefs.ts";
import { Button } from "../kit/Button.tsx";
import { cn } from "../kit/cn.ts";
import { ConfirmDialog } from "../kit/ConfirmDialog.tsx";
import { formatCount, formatRelative, formatTime } from "../kit/format.ts";
import { ErrorNotice, SkeletonRows } from "../kit/QueryState.tsx";
import { Switch } from "../kit/Switch.tsx";
import { Table, Td, Th, THead, Tr } from "../kit/Table.tsx";
import { useToast } from "../kit/Toast.tsx";
import { DIRECTION_LABEL, RuleChips, TargetsSummary } from "./parts.tsx";

const VIEW_KEY = "osstrace:alerts-view";

/** #alerts: purpose hero when empty; otherwise usage meters and every rule as cards (or a list). */
export function AlertsHome() {
  const alerts = useAlerts();
  const limits = useAlertLimits();
  const unread = useUnreadCount(true);
  const [view, setView] = useState<"grid" | "list">(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });
  const pick = (v: "grid" | "list") => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* ignore */
    }
  };

  if (alerts.isPending) return <SkeletonRows rows={6} className="kit-panel" />;
  if (alerts.isError) return <ErrorNotice error={alerts.error} onRetry={() => alerts.refetch()} />;
  const rules = alerts.data;

  if (rules.length === 0) {
    return (
      <section aria-labelledby="alerts-hero" className="kit-panel relative overflow-hidden px-8 py-14 sm:px-12">
        <div className="max-w-[560px]">
          <h1 id="alerts-hero" className="text-[30px] font-semibold leading-tight tracking-[-0.02em]">
            Know the moment watched money moves.
          </h1>
          <p className="mt-3 text-[14px] leading-relaxed text-muted">
            An alert watches addresses or your entities on Ethereum, BNB Chain and Solana and tells you when they send or receive funds above a floor you set, in the
            inbox, on the bell, and by webhook.
          </p>
          <a href="#alerts/new" className="kit-fade mt-6 inline-flex h-10 items-center gap-1.5 rounded-sm bg-accent px-4 text-[14px] font-semibold text-accent-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] hover:bg-accent-strong">
            <Plus aria-hidden className="size-4" /> Create your first alert
          </a>
          {limits.data ? (
            <p className="kit-mono mt-6 text-xs text-faint">
              Up to {limits.data.maxRules} rules, {limits.data.maxTargetsPerRule} targets each · checked every {limits.data.pollIntervalSec}s · only new activity fires
            </p>
          ) : null}
        </div>
        <HeroMark />
      </section>
    );
  }

  const targets = rules.reduce((n, r) => n + r.targets.length, 0);
  const active = rules.filter((r) => r.enabled).length;
  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="usage-h">
        <h2 id="usage-h" className="mb-3 text-[18px] font-semibold tracking-[-0.01em]">
          Usage
        </h2>
        <div className="kit-panel grid gap-x-8 gap-y-6 p-6 sm:grid-cols-2 xl:grid-cols-4">
          <Meter icon={<Bell aria-hidden className="size-4" />} label="Alert rules" value={rules.length} max={limits.data?.maxRules} />
          <Meter label="Active rules" value={active} max={rules.length} />
          <Meter label="Watched targets" value={targets} max={limits.data ? limits.data.maxTargetsPerRule * rules.length : undefined} note="across all rules" />
          <Meter label="Unread notifications" value={unread.data?.unreadCount ?? 0} note={<a href="#alerts/inbox" className="text-accent hover:underline">Open inbox</a>} />
        </div>
      </section>
      <section aria-labelledby="all-h">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 id="all-h" className="mr-auto text-[18px] font-semibold tracking-[-0.01em]">
            All alerts
          </h2>
          <div role="group" aria-label="Layout" className="inline-flex h-8 items-center rounded-sm border border-border bg-surface p-0.5">
            {(
              [
                ["grid", "Grid", LayoutGrid],
                ["list", "List", List],
              ] as const
            ).map(([v, l, Icon]) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                aria-label={`${l} view`}
                title={`${l} view`}
                onClick={() => pick(v)}
                className={cn("kit-fade inline-flex h-full w-8 items-center justify-center rounded-[4px]", view === v ? "bg-surface-3 text-text" : "text-muted hover:text-text")}
              >
                <Icon aria-hidden className="size-3.5" />
              </button>
            ))}
          </div>
          <Button icon={<Plus aria-hidden className="size-3.5" />} onClick={() => (window.location.hash = "#alerts/new")}>
            New alert
          </Button>
        </div>
        {view === "grid" ? <RuleCards rules={rules} /> : <RuleList rules={rules} />}
      </section>
    </div>
  );
}

function Meter({ label, value, max, note, icon }: { label: string; value: number; max?: number; note?: ReactNode; icon?: ReactNode }) {
  const pct = max ? Math.min(100, (value / Math.max(max, 1)) * 100) : null;
  return (
    <div className="flex flex-col gap-2.5">
      <p className="flex items-center gap-2 text-[13.5px] font-medium">
        {icon ? <span className="text-muted">{icon}</span> : null}
        {label}
      </p>
      {pct != null ? (
        <div role="meter" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} className="h-1.5 overflow-hidden rounded-full bg-surface-3">
          <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
      ) : (
        <div aria-hidden className="h-1.5 rounded-full bg-surface-3" />
      )}
      <p className="text-[13px]">
        <span className="kit-num text-[15px] font-semibold">{formatCount(value)}</span>
        {max != null ? <span className="text-muted"> of {formatCount(max)}</span> : null}
        {note ? <span className="ml-2 text-xs text-muted">{note}</span> : null}
      </p>
    </div>
  );
}

/** Shared kebab + pause/delete plumbing for cards and list rows. */
function useRuleActions() {
  const update = useUpdateAlert();
  const del = useDeleteAlert();
  const toast = useToast();
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [toDelete, setToDelete] = useState<AlertRule | null>(null);
  const setEnabled = (r: AlertRule, enabled: boolean) => {
    setPending((p) => ({ ...p, [r.id]: enabled }));
    update.mutate(
      { id: r.id, enabled },
      {
        onSuccess: () => toast.success(enabled ? `"${r.name}" resumed. Only new activity will fire.` : `"${r.name}" paused.`),
        onError: (e) => toast.error(e),
        onSettled: () =>
          setPending((p) => {
            const { [r.id]: _, ...rest } = p;
            return rest;
          }),
      },
    );
  };
  const dialog = (
    <ConfirmDialog
      open={!!toDelete}
      onOpenChange={(o) => {
        if (!o) {
          setToDelete(null);
          del.reset();
        }
      }}
      title="Delete alert"
      body={<p>Delete "{toDelete?.name}"? It stops watching immediately. This cannot be undone.</p>}
      confirmLabel="Delete alert"
      pending={del.isPending}
      error={del.error}
      onConfirm={() =>
        toDelete &&
        del.mutate(toDelete.id, {
          onSuccess: () => {
            toast.success(`Deleted "${toDelete.name}".`);
            setToDelete(null);
          },
        })
      }
    />
  );
  return { pending, setEnabled, askDelete: setToDelete, dialog };
}

function RuleMenu({ rule, enabled, onToggle, onDelete }: { rule: AlertRule; enabled: boolean; onToggle: () => void; onDelete: () => void }) {
  const item = "kit-fade flex h-8 cursor-pointer items-center gap-2 rounded-sm px-2 text-[13px] outline-none data-[highlighted]:bg-surface-2";
  return (
    <Menu.Root>
      <Menu.Trigger aria-label={`Actions for ${rule.name}`} className="kit-fade inline-flex size-8 items-center justify-center rounded-sm text-muted hover:bg-surface-2 hover:text-text data-[state=open]:bg-surface-2">
        <MoreVertical aria-hidden className="size-4" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content align="end" sideOffset={4} className="kit-overlay z-40 min-w-[168px] p-1">
          <Menu.Item className={item} onSelect={() => (window.location.hash = `#alerts/${rule.id}/edit`)}>
            <Pencil aria-hidden className="size-3.5 text-muted" /> Edit
          </Menu.Item>
          <Menu.Item className={item} onSelect={onToggle}>
            {enabled ? <Pause aria-hidden className="size-3.5 text-muted" /> : <Play aria-hidden className="size-3.5 text-muted" />}
            {enabled ? "Pause" : "Resume"}
          </Menu.Item>
          <Menu.Separator className="my-1 h-px bg-border" />
          <Menu.Item className={cn(item, "text-danger")} onSelect={onDelete}>
            <Trash2 aria-hidden className="size-3.5" /> Delete
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

function RuleCards({ rules }: { rules: AlertRule[] }) {
  const entities = useEntities();
  const methods = useNotificationMethods();
  const names = new Map((methods.data ?? []).map((m) => [m.id, m.name]));
  const { timezone } = usePrefs();
  const a = useRuleActions();
  const deliveryText = (rule: AlertRule) => {
    const hooks = rule.methodIds.map((id) => names.get(id)).filter(Boolean);
    return hooks.length ? `In-app, ${hooks.join(", ")}` : "In-app";
  };
  return (
    <>
      <ul aria-label="Alert rules" className="grid gap-3 lg:grid-cols-2">
        {rules.map((r) => {
          const enabled = a.pending[r.id] ?? r.enabled;
          return (
            <li key={r.id} className={cn("kit-panel flex flex-col gap-3 p-4", !enabled && "opacity-75")}>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <a href={`#alerts/${r.id}`} className="kit-fade block truncate text-[14px] font-semibold hover:text-accent">
                    {r.name}
                  </a>
                  <p className="mt-0.5 text-xs text-muted" title={formatTime(r.createdAt, timezone)}>
                    Created {formatRelative(r.createdAt)} · {deliveryText(r)}
                  </p>
                </div>
                <Switch checked={enabled} disabled={r.id in a.pending} onCheckedChange={(v) => a.setEnabled(r, v)} label={`${enabled ? "Pause" : "Resume"} ${r.name}`} />
                <RuleMenu rule={r} enabled={enabled} onToggle={() => a.setEnabled(r, !enabled)} onDelete={() => a.askDelete(r)} />
              </div>
              <RuleChips rule={r} entities={entities.data} max={6} />
              <p className="kit-mono flex gap-3 border-t border-border pt-2.5 text-xs text-muted">
                <span>{formatCount(r.eventCount)} events</span>
                <span>last {r.lastTriggeredAt ? formatRelative(r.lastTriggeredAt) : "never"}</span>
                <span className="ml-auto">{enabled ? "Watching" : "Paused"}</span>
              </p>
            </li>
          );
        })}
      </ul>
      {a.dialog}
    </>
  );
}

function RuleList({ rules }: { rules: AlertRule[] }) {
  const entities = useEntities();
  const { timezone } = usePrefs();
  const a = useRuleActions();
  return (
    <div className="kit-panel">
      <Table label="Alert rules">
        <THead>
          <tr>
            <Th>Name</Th>
            <Th>Watching</Th>
            <Th>Direction</Th>
            <Th num>Min USD</Th>
            <Th num>Events</Th>
            <Th className="hidden xl:table-cell">Last triggered</Th>
            <Th>On</Th>
            <Th>
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </THead>
        <tbody>
          {rules.map((r) => {
            const enabled = a.pending[r.id] ?? r.enabled;
            return (
              <Tr key={r.id}>
                <Td className="max-w-64">
                  <a href={`#alerts/${r.id}`} className="kit-fade block truncate font-medium hover:text-accent">
                    {r.name}
                  </a>
                </Td>
                <Td className="max-w-72">
                  <TargetsSummary targets={r.targets} entities={entities.data} />
                </Td>
                <Td className="whitespace-nowrap text-muted">{DIRECTION_LABEL[r.direction]}</Td>
                <Td num>{r.minUsd == null ? <span className="text-muted">Any</span> : `$${r.minUsd.toLocaleString("en-US")}`}</Td>
                <Td num>{formatCount(r.eventCount)}</Td>
                <Td className="kit-num hidden whitespace-nowrap text-muted xl:table-cell">
                  {r.lastTriggeredAt ? <span title={formatTime(r.lastTriggeredAt, timezone)}>{formatRelative(r.lastTriggeredAt)}</span> : "Never"}
                </Td>
                <Td>
                  <Switch checked={enabled} disabled={r.id in a.pending} onCheckedChange={(v) => a.setEnabled(r, v)} label={`${enabled ? "Pause" : "Resume"} ${r.name}`} />
                </Td>
                <Td className="w-10 text-right">
                  <RuleMenu rule={r} enabled={enabled} onToggle={() => a.setEnabled(r, !enabled)} onDelete={() => a.askDelete(r)} />
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
      {a.dialog}
    </div>
  );
}

/** Quiet authored mark for the empty hero: the ruled statement with its lens, drawn large in hairlines. */
function HeroMark() {
  return (
    <svg aria-hidden viewBox="0 0 240 240" className="pointer-events-none absolute -right-6 top-1/2 hidden w-[280px] -translate-y-1/2 text-border-strong lg:block" fill="none">
      <rect x="20" y="20" width="200" height="200" rx="28" stroke="currentColor" strokeWidth="1.5" />
      {[70, 100, 130, 160].map((y, i) => (
        <path key={y} d={`M56 ${y}h${[110, 150, 90, 60][i]}`} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      ))}
      <circle cx="160" cy="166" r="26" stroke="var(--trace-accent)" strokeWidth="2" />
      <path d="m179 185 18 18" stroke="var(--trace-accent)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
