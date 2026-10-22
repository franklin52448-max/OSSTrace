import type { AlertRule, Chain } from "@osstrace/contract";
import { House, Inbox, PanelLeftClose, PanelLeftOpen, Pause, Play, Plus, Search, SlidersHorizontal } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useAlertLimits, useAlerts, useUnreadCount, useUpdateAlert } from "./api.ts";
import { useDocumentTitle } from "../kit/hooks.ts";
import { buttonClass } from "../kit/Button.tsx";
import { cn } from "../kit/cn.ts";
import { Input } from "../kit/Field.tsx";
import { useToast } from "../kit/Toast.tsx";
import { AlertModal } from "./AlertModal.tsx";

const COLLAPSE_KEY = "osstrace:alerts-sidebar-collapsed";

export type AlertsActive = { kind: "home" } | { kind: "manage" } | { kind: "inbox" } | { kind: "detail"; id: string };

/** Alerts frame: collapsible page sidebar (sections, search, rule list, new button, usage) + main area.
 *  `#alerts/new` opens the create dialog over it. */
export function AlertsLayout({
  active,
  creating,
  prefill,
  onCreateOpenChange,
  onCreated,
  children,
}: {
  active: AlertsActive;
  creating: boolean;
  prefill: { chain: Chain | null; address: string | null; entityId: string | null };
  onCreateOpenChange: (o: boolean) => void;
  onCreated: (rule: AlertRule) => void;
  children: ReactNode;
}) {
  useDocumentTitle("Alerts");
  const toast = useToast();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !c;
    });

  return (
    <div className="flex min-h-full gap-5 p-[var(--trace-page-gutter)]">
      <AlertsSidebar collapsed={collapsed} onToggle={toggle} active={active} />
      <div className="min-w-0 flex-1">{children}</div>
      <AlertModal
        open={creating}
        onOpenChange={(o) => {
          if (!o) window.location.hash = "#alerts";
          onCreateOpenChange(o);
        }}
        prefill={prefill}
        onSaved={(rule) => {
          toast.success(`Created "${rule.name}". It fires on new activity from now on.`);
          window.location.hash = `#alerts/${rule.id}`;
          onCreated(rule);
        }}
      />
    </div>
  );
}

function AlertsSidebar({ collapsed, onToggle, active }: { collapsed: boolean; onToggle: () => void; active: AlertsActive }) {
  const alerts = useAlerts();
  const limits = useAlertLimits();
  const unread = useUnreadCount(true);
  const [q, setQ] = useState("");
  const rules = useMemo(() => {
    const f = q.trim().toLowerCase();
    const all = alerts.data ?? [];
    return f ? all.filter((r) => r.name.toLowerCase().includes(f)) : all;
  }, [alerts.data, q]);
  const count = alerts.data?.length ?? 0;
  const atLimit = limits.data != null && count >= limits.data.maxRules;
  const unreadCount = unread.data?.unreadCount ?? 0;

  const compact = (
    <aside aria-label="Alerts navigation" className={cn("kit-panel sticky top-[var(--trace-page-gutter)] flex h-[calc(100dvh-var(--trace-topbar-h)-2*var(--trace-page-gutter))] w-14 shrink-0 flex-col items-center gap-1 py-2", !collapsed && "md:hidden")}>
        <SideIconButton label="Expand alerts sidebar" onClick={onToggle} icon={<PanelLeftOpen aria-hidden className="size-4" />} />
        <SideIconLink href="#alerts" label="Home" icon={<House aria-hidden className="size-4" />} isActive={active.kind === "home"} />
        <SideIconLink href="#alerts/manage" label="Manage" icon={<SlidersHorizontal aria-hidden className="size-4" />} isActive={active.kind === "manage"} />
        <SideIconLink href="#alerts/inbox" label={unreadCount ? `Inbox, ${unreadCount} unread` : "Inbox"} icon={<Inbox aria-hidden className="size-4" />} isActive={active.kind === "inbox"} />
        <a href="#alerts/new" aria-label="New alert" title="New alert" className={buttonClass("primary", "md", "mt-auto size-9 px-0")}>
          <Plus aria-hidden className="size-4" />
        </a>
      </aside>
  );
  if (collapsed) return compact;

  return (
    <>
    {compact}
    <aside
      aria-label="Alerts navigation"
      className="kit-panel sticky top-[var(--trace-page-gutter)] hidden h-[calc(100dvh-var(--trace-topbar-h)-2*var(--trace-page-gutter))] w-[var(--trace-sidebar-w)] shrink-0 flex-col md:flex"
    >
      <div className="kit-panel-head">
        <h2 className="kit-panel-title">Alerts</h2>
        <SideIconButton label="Collapse alerts sidebar" onClick={onToggle} icon={<PanelLeftClose aria-hidden className="size-4" />} />
      </div>
      <nav aria-label="Alerts sections" className="flex flex-col gap-0.5 p-2">
        <SideLink href="#alerts" icon={<House aria-hidden className="size-4" />} isActive={active.kind === "home"}>
          Home
        </SideLink>
        <SideLink href="#alerts/manage" icon={<SlidersHorizontal aria-hidden className="size-4" />} isActive={active.kind === "manage"}>
          Manage
        </SideLink>
        <SideLink href="#alerts/inbox" icon={<Inbox aria-hidden className="size-4" />} isActive={active.kind === "inbox"}>
          Inbox
          {unreadCount > 0 ? <span className="kit-num ml-auto rounded-[4px] bg-accent-soft px-1.5 text-[11px] text-accent">{unreadCount}</span> : null}
        </SideLink>
      </nav>
      <div className="px-2 pb-2">
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
          <Input type="search" aria-label="Search alerts" placeholder="Search alerts" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
        </div>
      </div>
      <ul aria-label="Alert rules" className="min-h-0 flex-1 overflow-y-auto border-t border-border p-2">
        {alerts.isPending ? (
          <li className="px-2 py-2 text-xs text-muted">Loading rules</li>
        ) : alerts.isError ? (
          <li className="px-2 py-2 text-xs text-danger">Could not load rules.</li>
        ) : rules.length === 0 ? (
          <li className="px-2 py-2 text-[13px] text-muted">{q.trim() ? `No rule names match "${q.trim()}".` : "Your alert rules will be listed here."}</li>
        ) : (
          rules.map((r) => <RuleRow key={r.id} rule={r} active={active.kind === "detail" && active.id === r.id} />)
        )}
      </ul>
      <div className="flex flex-col gap-2.5 border-t border-border p-3">
        {atLimit ? (
          <button type="button" disabled className={buttonClass("primary", "md", "h-9 w-full")}>
            <Plus aria-hidden className="size-4" /> New alert
          </button>
        ) : (
          <a href="#alerts/new" className={buttonClass("primary", "md", "h-9 w-full")}>
            <Plus aria-hidden className="size-4" /> New alert
          </a>
        )}
        <div className="flex items-center justify-between rounded-sm border border-border bg-surface-2 px-2.5 py-1.5">
          <span className="kit-colhead">Rules</span>
          <span className="kit-num text-xs text-muted">
            {limits.data ? `${count} of ${limits.data.maxRules}` : count}
            {alerts.data ? ` · ${alerts.data.filter((r) => r.enabled).length} active` : ""}
          </span>
        </div>
        {atLimit ? <p className="text-xs text-muted">Rule limit reached. Delete a rule to add another.</p> : null}
      </div>
    </aside>
    </>
  );
}

function RuleRow({ rule, active }: { rule: AlertRule; active: boolean }) {
  const update = useUpdateAlert();
  const toast = useToast();
  const [pending, setPending] = useState<boolean | null>(null);
  const enabled = pending ?? rule.enabled;
  return (
    <li className="group relative">
      <a
        href={`#alerts/${rule.id}`}
        aria-current={active ? "page" : undefined}
        className={cn("kit-fade flex h-9 items-center gap-2 rounded-sm pl-2.5 pr-10 text-[13px]", active ? "bg-accent-soft font-medium text-accent" : "hover:bg-surface-2", !enabled && "text-muted")}
      >
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", enabled ? "bg-accent" : "bg-border-strong")} />
        <span className="truncate">{rule.name}</span>
      </a>
      <button
        type="button"
        aria-label={enabled ? `Pause ${rule.name}` : `Resume ${rule.name}`}
        title={enabled ? "Pause" : "Resume"}
        disabled={update.isPending}
        onClick={() => {
          const next = !enabled;
          setPending(next);
          update.mutate(
            { id: rule.id, enabled: next },
            {
              onSuccess: () => toast.success(next ? `"${rule.name}" resumed. Only new activity will fire.` : `"${rule.name}" paused.`),
              onError: (e) => toast.error(e),
              onSettled: () => setPending(null),
            },
          );
        }}
        className="kit-fade absolute right-1 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-sm text-muted opacity-70 hover:bg-surface-3 hover:text-text hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
      >
        {enabled ? <Pause aria-hidden className="size-3.5" /> : <Play aria-hidden className="size-3.5" />}
      </button>
    </li>
  );
}

function SideLink({ href, isActive, icon, children }: { href: string; isActive?: boolean; icon: ReactNode; children: ReactNode }) {
  return (
    <a
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={cn("kit-fade flex h-9 items-center gap-2.5 rounded-sm px-2.5 text-[13px] font-medium", isActive ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-text")}
    >
      {icon}
      {children}
    </a>
  );
}

function SideIconLink({ href, label, icon, isActive }: { href: string; label: string; icon: ReactNode; isActive?: boolean }) {
  return (
    <a
      href={href}
      aria-label={label}
      title={label}
      aria-current={isActive ? "page" : undefined}
      className={cn("kit-fade inline-flex size-9 items-center justify-center rounded-sm", isActive ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-text")}
    >
      {icon}
    </a>
  );
}

function SideIconButton({ label, onClick, icon }: { label: string; onClick: () => void; icon: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="kit-fade inline-flex size-8 items-center justify-center rounded-sm text-muted hover:bg-surface-3 hover:text-text">
      {icon}
    </button>
  );
}
