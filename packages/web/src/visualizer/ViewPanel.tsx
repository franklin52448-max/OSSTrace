import { CHAIN_NAMES, type SyncStatus, type VisualizerState } from "@osstrace/contract";
import { CHAIN_OPTIONS } from "../ChainSelect.tsx";
import { Ban, ChevronDown, GitBranch, Save, Share2, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button, IconButton } from "../kit/Button.tsx";
import { cn } from "../kit/cn.ts";
import { formatUsd, shortAddress } from "../kit/format.ts";
import { SyncBadge } from "../kit/SyncBadge.tsx";
import { FilterChip, formatRelative, NumberField, SegTabs } from "../panels/parts.tsx";
import type { BaseItem } from "./lib/urlState.ts";

export const VIZ_TIME_PRESETS = [
  { value: "1d", label: "24h", ms: 86400e3 },
  { value: "7d", label: "7d", ms: 7 * 86400e3 },
  { value: "30d", label: "30d", ms: 30 * 86400e3 },
  { value: "90d", label: "90d", ms: 90 * 86400e3 },
  { value: "1y", label: "1y", ms: 365 * 86400e3 },
  { value: "all", label: "All time", ms: 0 },
] as const;

function Section({ title, count, children, defaultOpen = true, aside }: { title: string; count?: number; children: ReactNode; defaultOpen?: boolean; aside?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-border">
      <div className="flex h-10 items-center gap-1.5 px-3">
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="kit-sect-h kit-fade flex flex-1 items-center gap-1.5 text-left hover:text-text">
          {title}
          {count != null ? <span className="kit-num rounded-sm border border-border px-1.5 text-[11px] normal-case leading-[18px] tracking-normal">{count}</span> : null}
          <ChevronDown aria-hidden className={cn("ml-auto size-3.5 text-faint transition-transform", !open && "-rotate-90")} />
        </button>
        {aside}
      </div>
      {open ? <div className="px-3 pb-3">{children}</div> : null}
    </section>
  );
}

export type ViewPanelProps = {
  mode: "scratch" | "owner" | "shared";
  name: string;
  onRename: (n: string) => void;
  stats: { transferCount: number; volumeUSD: number; unpriced: number; tokenCount: number; chainCount: number };
  loadedNote: string | null;
  sync?: SyncStatus;
  state: VisualizerState;
  baseLabel: (b: BaseItem) => string;
  editable: boolean;
  onToggleExclude: (b: BaseItem) => void;
  onRemoveBase: (b: BaseItem) => void;
  onTraceFrom: (b: BaseItem) => void;
  onFilter: (f: Partial<VisualizerState["filter"]>) => void;
  onTimePreset: (ms: number) => void;
  tokenOptions: { id: string; label: string }[];
  isSaving: boolean;
  lastSavedAt: string | null;
  onSave: () => void;
  onShare: () => void;
};

export function ViewPanel(p: ViewPanelProps) {
  const [name, setName] = useState(p.name);
  useEffect(() => setName(p.name), [p.name]);
  const f = p.state.filter;
  const included = p.state.base.filter((b) => !b.exclude);
  const preset = (() => {
    const g = p.state.timeRange.gte;
    if (g == null && p.state.timeRange.lte == null) return "all";
    if (g == null) return null;
    const age = Date.now() - g;
    return VIZ_TIME_PRESETS.find((t) => t.ms && Math.abs(age - t.ms) < 3600e3)?.value ?? null;
  })();
  return (
    <aside aria-label="View" className="kit-overlay pointer-events-auto flex max-h-full w-[300px] flex-col overflow-hidden" data-canvas-scroll-region>
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border px-3">
        {p.mode === "owner" && p.editable ? (
          <input aria-label="View name" value={name} maxLength={256} onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name.trim() !== p.name && p.onRename(name.trim())}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            className="min-w-0 flex-1 rounded-sm bg-transparent px-1 py-1 text-[18px] font-semibold tracking-[-0.01em] hover:bg-surface-2 focus-visible:bg-surface-2" />
        ) : (
          <h1 className="min-w-0 flex-1 truncate px-1 text-[18px] font-semibold tracking-[-0.01em]">{p.mode === "scratch" ? "Scratch view" : p.name}</h1>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="Overview">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-[10px]" title="Counts what is visible on the canvas">
            <dt className="text-[13px] leading-none text-muted">Transfer volume</dt>
            <dd className="kit-num text-right text-[13px] leading-none">{formatUsd(p.stats.volumeUSD)}{p.stats.unpriced ? "+" : ""}</dd>
            <dt className="text-[13px] leading-none text-muted">Transfers</dt>
            <dd className="kit-num text-right text-[13px] leading-none">{p.stats.transferCount.toLocaleString("en-US")}</dd>
            <dt className="text-[13px] leading-none text-muted">Tokens</dt>
            <dd className="kit-num text-right text-[13px] leading-none">{p.stats.tokenCount}</dd>
            <dt className="text-[13px] leading-none text-muted">Chains</dt>
            <dd className="kit-num text-right text-[13px] leading-none">{p.stats.chainCount}</dd>
          </dl>
          {p.sync && p.sync.state !== "ready" ? <div className="mt-2"><SyncBadge sync={p.sync} /></div> : null}
          {p.stats.unpriced ? <p className="mt-1.5 text-xs text-faint">{p.stats.unpriced} visible transfers have no USD price.</p> : null}
          {p.loadedNote ? <p className="mt-1.5 text-xs text-warn">{p.loadedNote}</p> : null}
        </Section>
        <Section title="Base nodes" count={p.state.base.length}>
          {p.state.base.length === 0 ? <p className="text-[13px] text-muted">No base nodes yet.</p> : null}
          <ul className="flex flex-col gap-1">
            {p.state.base.map((b) => {
              const lastIncluded = !b.exclude && included.length === 1;
              return (
                <li key={`${b.type}:${b.value}`} className={cn("flex h-9 items-center gap-2 rounded-sm border border-border bg-bg pl-2", b.exclude && "opacity-60")}>
                  <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full border-2", b.exclude ? "border-border-strong" : "border-accent")} />
                  <span className={cn("min-w-0 flex-1 truncate text-[13px]", b.type !== "entity" && /…/.test(p.baseLabel(b)) && "kit-mono text-[12px]", b.exclude && "line-through")} title={b.value}>{p.baseLabel(b)}</span>
                  {!b.exclude ? <IconButton size="sm" label="Send to Tracer from here" onClick={() => p.onTraceFrom(b)}><GitBranch aria-hidden className="size-3.5" /></IconButton> : null}
                  {p.editable ? (
                    <>
                      <IconButton size="sm" label={b.exclude ? "Include again" : lastIncluded ? "The last included node cannot be excluded" : "Exclude from view"} disabled={lastIncluded} onClick={() => p.onToggleExclude(b)}>
                        <Ban aria-hidden className={cn("size-3.5", b.exclude && "text-danger")} />
                      </IconButton>
                      <IconButton size="sm" label="Remove" onClick={() => p.onRemoveBase(b)}><X aria-hidden className="size-3.5" /></IconButton>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Section>
        <Section title="Filters">
          <div className="flex flex-col gap-2">
            <SegTabs label="Direction" value={f.flow} onChange={(flow) => p.editable && p.onFilter({ flow })} items={[{ value: "all", label: "All" }, { value: "in", label: "In" }, { value: "out", label: "Out" }, { value: "self", label: "Self" }]} />
            <div className="flex flex-wrap gap-1.5">
              <FilterChip label="USD" value={f.usdGte != null || f.usdLte != null ? `${f.usdGte != null ? `≥$${f.usdGte}` : ""}${f.usdLte != null ? ` ≤$${f.usdLte}` : ""}` : undefined} active={f.usdGte != null || f.usdLte != null}>
                <div className="flex flex-col gap-2">
                  <NumberField label="Minimum USD" value={f.usdGte} onCommit={(usdGte) => p.onFilter({ usdGte })} placeholder="No minimum" />
                  <NumberField label="Maximum USD" value={f.usdLte} onCommit={(usdLte) => p.onFilter({ usdLte })} placeholder="No maximum" />
                </div>
              </FilterChip>
              <FilterChip label="Time" value={preset ? VIZ_TIME_PRESETS.find((t) => t.value === preset)?.label : "Custom"} active={preset !== "all"}>
                <div className="grid grid-cols-3 gap-1" role="radiogroup" aria-label="Time range">
                  {VIZ_TIME_PRESETS.map((t) => (
                    <button key={t.value} type="button" role="radio" aria-checked={preset === t.value} onClick={() => p.onTimePreset(t.ms)}
                      className={cn("kit-fade h-7 rounded-sm border px-2 text-xs", preset === t.value ? "border-accent text-text" : "border-border text-muted hover:text-text")}>
                      {t.label}
                    </button>
                  ))}
                </div>
              </FilterChip>
              <FilterChip label="Token" value={f.tokens?.length ? String(f.tokens.length) : undefined} active={!!f.tokens?.length}>
                {p.tokenOptions.length === 0 ? <p className="text-xs text-muted">Tokens appear once transfers load.</p> : (
                  <div className="flex max-h-60 flex-col gap-1 overflow-auto">
                    {p.tokenOptions.map((t) => {
                      const on = f.tokens?.includes(t.id) ?? false;
                      return (
                        <label key={t.id} className="flex cursor-pointer items-center gap-2 text-[13px]">
                          <input type="checkbox" className="size-3.5 accent-[var(--trace-accent)]" checked={on}
                            onChange={() => {
                              const s = new Set(f.tokens ?? []);
                              if (on) s.delete(t.id);
                              else s.add(t.id);
                              p.onFilter({ tokens: s.size ? [...s] : null });
                            }} />
                          <span className="kit-mono">{t.label}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </FilterChip>
              <FilterChip label="Chain" value={f.chains?.length ? f.chains.map((c) => CHAIN_NAMES[c]).join(", ") : undefined} active={!!f.chains?.length}>
                <div className="flex flex-col gap-1">
                  {/* Every chain the picker offers, not a hard-coded two: a BNB or Robinhood Chain row
                      could otherwise be in the graph with no way to filter to (or out) its chain. */}
                  {CHAIN_OPTIONS.map(({ value: c }) => {
                    const on = f.chains?.includes(c) ?? false;
                    return (
                      <label key={c} className="flex cursor-pointer items-center gap-2 text-[13px]">
                        <input type="checkbox" className="size-3.5 accent-[var(--trace-accent)]" checked={on}
                          onChange={() => {
                            const s = new Set(f.chains ?? []);
                            if (on) s.delete(c);
                            else s.add(c);
                            p.onFilter({ chains: s.size ? [...s] : null });
                          }} />
                        <span>{CHAIN_NAMES[c]}</span>
                      </label>
                    );
                  })}
                </div>
              </FilterChip>
            </div>
          </div>
        </Section>
      </div>
      <footer className="flex h-11 shrink-0 items-center justify-between gap-2 border-t border-border px-3 text-xs text-faint" aria-live="polite">
        {p.mode === "scratch" ? (
          <>
            <span className="flex items-center gap-2"><span aria-hidden className="size-1.5 rounded-full border border-border-strong" />Not saved: lives in the URL</span>
            <Button size="sm" variant="primary" icon={<Save aria-hidden className="size-3.5" />} onClick={p.onSave} disabled={p.state.base.length === 0}>Save view</Button>
          </>
        ) : p.mode === "owner" && p.editable ? (
          <>
            <span className="flex items-center gap-2"><span aria-hidden className={cn("size-1.5 rounded-full", p.isSaving ? "bg-accent" : "bg-border-strong")} />{p.isSaving ? "Saving…" : p.lastSavedAt ? `Updated ${formatRelative(p.lastSavedAt)}` : "Saved"}</span>
            <Button size="sm" icon={<Share2 aria-hidden className="size-3.5" />} onClick={p.onShare}>Share</Button>
          </>
        ) : (
          <span>View only</span>
        )}
      </footer>
    </aside>
  );
}

export const baseFallbackLabel = (b: BaseItem) => (b.type === "entity" ? "Entity" : shortAddress(b.value.slice(b.value.indexOf(":") + 1), 6, 6));
