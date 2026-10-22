/** Small building blocks shared by the data panels, tracer and visualizer. */
import * as Popover from "@radix-ui/react-popover";
import { ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";
import { useToast } from "../kit/Toast.tsx";
import { cn } from "../kit/cn.ts";
import type { ReactNode } from "react";

/** In-panel direction tabs (radio semantics: one active, arrow keys move).
 *  `seg` = a segmented control on a surface-2 track; `tabs` = mono caps tabs for a panel header strip. */
export function SegTabs<T extends string>({ value, onChange, items, label, className, variant = "seg" }: { value: T; onChange: (v: T) => void; items: { value: T; label: string }[]; label: string; className?: string; variant?: "seg" | "tabs" }) {
  const tabs = variant === "tabs";
  return (
    <div role="radiogroup" aria-label={label} className={cn(tabs ? "flex h-10 items-stretch" : "inline-flex h-7 items-center rounded-sm border border-border bg-surface-2 p-0.5", className)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const i = items.findIndex((x) => x.value === value);
        const n = items[(i + (e.key === "ArrowRight" ? 1 : items.length - 1)) % items.length];
        if (n) {
          e.preventDefault();
          onChange(n.value);
          (e.currentTarget.querySelectorAll("button")[items.indexOf(n)] as HTMLButtonElement | undefined)?.focus();
        }
      }}
    >
      {items.map((it) => {
        const on = it.value === value;
        return (
          <button key={it.value} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} onClick={() => onChange(it.value)} data-state={on ? "active" : undefined}
            className={tabs ? "kit-ptab shrink-0 whitespace-nowrap" : cn("kit-fade h-full rounded-[3px] px-2 text-xs font-medium", on ? "bg-[var(--trace-surface-3,var(--trace-border))] text-text" : "text-muted hover:text-text")}>
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

/** Header strip for a data panel: tabs on the left, meta/actions on the right. */
export function PanelStrip({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 items-stretch border-b border-border bg-surface-2 pr-2">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none]">{children}</div>
      {aside ? <div className="flex shrink-0 items-center gap-2 pl-2">{aside}</div> : null}
    </div>
  );
}

/** A filter chip that opens a popover with its editor. `active` chips show their value in ink. */
export function FilterChip({ label, value, active, children, align = "start" }: { label: string; value?: ReactNode; active?: boolean; children: ReactNode; align?: "start" | "end" }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className={cn("kit-fade inline-flex h-7 items-center gap-1 rounded-sm border px-2 text-xs", active ? "border-[color-mix(in_srgb,var(--trace-accent)_45%,var(--trace-border))] bg-accent-soft text-accent" : "border-border text-muted hover:border-border-strong hover:text-text")}>
          <span>{label}</span>
          {value != null ? <span className="kit-num font-medium">{value}</span> : null}
          <ChevronDown aria-hidden className="size-3 opacity-70" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align={align} sideOffset={4} className="kit-overlay z-[70] min-w-48 p-3 text-[13px]" data-state="open">
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function Pager({ page, pages, onPage, label = "Pages" }: { page: number; pages: number; onPage: (p: number) => void; label?: string }) {
  if (pages <= 1) return null;
  return (
    <nav aria-label={label} className="flex items-center gap-1 text-xs text-muted">
      <button type="button" aria-label="Previous page" disabled={page <= 0} onClick={() => onPage(page - 1)} className="kit-fade rounded-sm p-1 hover:bg-surface-2 hover:text-text disabled:opacity-40">
        <ChevronLeft aria-hidden className="size-3.5" />
      </button>
      <span className="kit-num">
        {page + 1} / {pages}
      </span>
      <button type="button" aria-label="Next page" disabled={page >= pages - 1} onClick={() => onPage(page + 1)} className="kit-fade rounded-sm p-1 hover:bg-surface-2 hover:text-text disabled:opacity-40">
        <ChevronRight aria-hidden className="size-3.5" />
      </button>
    </nav>
  );
}

type ToastApi = ReturnType<typeof useToast>;
const consoleToast: ToastApi = { success: () => {}, info: () => {}, error: (e) => console.warn("[panels]", e) };

/** useToast that degrades to a no-op when the shell's ToastProvider is not mounted (tests, isolated renders). */
export function useSafeToast(): ToastApi {
  try {
    return useToast();
  } catch {
    return consoleToast;
  }
}

const pad2 = (n: number) => String(n).padStart(2, "0");
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatRelative(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 24) return `${mo}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}

/** Compact count: 1,234 / 12.3K. */
export function formatCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString("en-US");
}

/** Number input that commits on blur/Enter; empty means "no limit". */
export function NumberField({ label, value, onCommit, min = 0, placeholder }: { label: string; value: number | null; onCommit: (v: number | null) => void; min?: number; placeholder?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      <input
        type="number"
        inputMode="decimal"
        min={min}
        defaultValue={value ?? ""}
        placeholder={placeholder}
        key={value ?? "none"}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        onBlur={(e) => {
          const raw = e.target.value.trim();
          const n = raw === "" ? null : Number(raw);
          onCommit(n === null || Number.isNaN(n) ? null : Math.max(min, n));
        }}
        className="kit-num h-8 w-full rounded-sm border border-border bg-surface px-2 text-[13px] focus-visible:border-accent"
      />
    </label>
  );
}
