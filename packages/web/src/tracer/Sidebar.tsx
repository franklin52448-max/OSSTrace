import { CHAIN_NAMES, type TraceDoc, type TraceNode } from "@osstrace/contract";
import { ChevronDown, ChevronLeft, PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { Button, IconButton } from "../kit/Button.tsx";
import { cn } from "../kit/cn.ts";
import { formatUsd, shortAddress } from "../kit/format.ts";
import { formatRelative } from "../panels/parts.tsx";
import { nodeTitle } from "./canvas/NodeCard.tsx";
import type { EdgeSummary } from "./lib/edges.ts";
import { ChainIcon } from "../ChainSelect.tsx";

const NOTES_DEBOUNCE_MS = 1500;

function Section({ title, count, children, defaultOpen = true, onHeaderClick, active }: { title: string; count?: number; children: React.ReactNode; defaultOpen?: boolean; onHeaderClick?: () => void; active?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-border">
      <div className={cn("flex h-10 items-center gap-1.5 px-3", active && "bg-accent-soft")}>
        {onHeaderClick ? (
          <button type="button" className={cn("kit-sect-h kit-fade flex-1 text-left hover:text-text", active && "text-text")} onClick={onHeaderClick} title="Show every added transfer">
            {title}
          </button>
        ) : (
          <h2 className="kit-sect-h flex-1">{title}</h2>
        )}
        {count != null ? <span className="kit-num rounded-sm border border-border px-1.5 text-[11px] leading-[18px] text-muted">{count}</span> : null}
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="kit-fade -mr-1 rounded-sm p-1 text-faint hover:bg-surface-2 hover:text-text" aria-label={`${open ? "Collapse" : "Expand"} ${title}`}>
          <ChevronDown aria-hidden className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
        </button>
      </div>
      <div className={cn("grid transition-[grid-template-rows] duration-200", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <div className="min-h-0 overflow-hidden">{children}</div>
      </div>
    </section>
  );
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-[5px]" title={title}>
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="kit-num text-[13px] text-text">{value}</dd>
    </div>
  );
}

export const Sidebar = memo(function Sidebar(props: {
  doc: TraceDoc;
  overview: EdgeSummary;
  readOnly: boolean;
  selectedIds: Set<string>;
  summarySelected: boolean;
  onSelectSummary: () => void;
  onSelectNode: (node: TraceNode, additive: boolean) => void;
  onTitle: (t: string) => void;
  onNotes: (n: string) => Promise<boolean>;
  onAdd: () => void;
  isSaving: boolean;
  lastSavedAt: string | null;
  backHref: string;
  /** Collapse to the header while the inspector needs the room (user can re-open). */
  autoCollapse?: boolean;
}) {
  const { doc, overview, readOnly, selectedIds } = props;
  const [collapsed, setCollapsed] = useState(!!props.autoCollapse);
  useEffect(() => setCollapsed(!!props.autoCollapse), [props.autoCollapse]);
  const [title, setTitle] = useState(doc.title);
  useEffect(() => setTitle(doc.title), [doc.title]);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const id = [...selectedIds].at(-1);
    if (!id) return;
    listRef.current?.querySelector(`[data-row-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedIds]);
  const nodes = doc.nodes.filter((n) => n.kind !== "transaction");
  const commitTitle = () => {
    const t = title.trim().slice(0, 256);
    if (t !== doc.title) props.onTitle(t);
  };

  return (
    <aside aria-label="Trace" className={cn("kit-overlay pointer-events-auto flex w-[300px] flex-col overflow-hidden", collapsed ? "h-[52px]" : "h-full")} data-canvas-scroll-region>
      <header className="flex h-[52px] shrink-0 items-center gap-1 border-b border-border px-2">
        <a href={props.backHref} aria-label="All traces" title="All traces" className="kit-fade rounded-sm p-1 text-muted hover:bg-surface-2 hover:text-text">
          <ChevronLeft aria-hidden className="size-4" />
        </a>
        {readOnly ? (
          <h1 className="min-w-0 flex-1 truncate text-[18px] font-semibold tracking-[-0.01em]">{doc.title || "Untitled trace"}</h1>
        ) : (
          <input
            aria-label="Trace title"
            value={title}
            maxLength={256}
            placeholder="Untitled trace"
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                setTitle(doc.title);
                (e.target as HTMLInputElement).blur();
              }
            }}
            className="min-w-0 flex-1 rounded-sm bg-transparent px-1 py-1 text-[18px] font-semibold tracking-[-0.01em] placeholder:text-faint hover:bg-surface-2 focus-visible:bg-surface-2"
          />
        )}
        <IconButton size="sm" label={collapsed ? "Expand panel" : "Collapse panel"} onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? <PanelLeftOpen aria-hidden className="size-3.5" /> : <PanelLeftClose aria-hidden className="size-3.5" />}
        </IconButton>
      </header>
      {!collapsed ? (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Section title="Trace overview" onHeaderClick={props.onSelectSummary} active={props.summarySelected}>
              <dl className="px-3 pb-3">
                <Stat label="Transfer volume" value={`${formatUsd(overview.totalUSD)}${overview.usdIncomplete ? "+" : ""}`} title={overview.usdIncomplete ? "Some added transfers have no USD price; the total is a lower bound" : undefined} />
                <Stat label="Transfers" value={overview.transferCount.toLocaleString("en-US")} />
                <Stat label="Tokens" value={String(overview.tokens.length)} title={overview.tokens.join(", ") || "Counted from added transfers only"} />
                <Stat label="Chains" value={String(overview.chains.length)} title={overview.chains.join(", ") || "Counted from added transfers only"} />
              </dl>
            </Section>
            <Section title="Nodes" count={nodes.length}>
              {nodes.length === 0 ? (
                <div className="flex flex-col items-start gap-2 px-3 pb-3 text-[13px]">
                  <p className="text-muted">Nothing here yet. Add an address or one of your entities to start.</p>
                  {!readOnly ? (
                    <Button size="sm" icon={<Plus aria-hidden className="size-3.5" />} onClick={props.onAdd}>
                      Add node
                    </Button>
                  ) : null}
                </div>
              ) : (
                <ul ref={listRef} className="max-h-[38vh] overflow-y-auto pb-1.5">
                  {nodes.map((n) => {
                    const { title: t, mono } = nodeTitle(n);
                    const sel = selectedIds.has(n.id);
                    const addr = n.address ?? n.displayAddress?.address;
                    const sub = n.kind === "entity" ? `Entity${n.displayEntity?.type ? ` · ${n.displayEntity.type}` : ""}` : addr && !mono ? shortAddress(addr, addr.startsWith("0x") ? 6 : 4, 4) : CHAIN_NAMES[n.chain ?? "ethereum"];
                    return (
                      <li key={n.id} data-row-id={n.id} className="[content-visibility:auto] [contain-intrinsic-size:auto_48px]">
                        <button type="button" aria-pressed={sel} onClick={(e) => props.onSelectNode(n, e.shiftKey)} title={addr ?? t}
                          className={cn("kit-fade flex h-12 w-full items-center gap-2.5 px-3 text-left hover:bg-surface-2", sel && "bg-accent-soft hover:bg-accent-soft")}>
                          <span aria-hidden className={cn("kit-node-tile flex size-7 shrink-0 items-center justify-center rounded-[5px]", n.kind === "entity" && "text-[12px] font-semibold text-text")}
                            style={n.color ? { color: `var(--trace-node-${n.color})`, borderColor: `color-mix(in srgb, var(--trace-node-${n.color}) 50%, transparent)`, background: `color-mix(in srgb, var(--trace-node-${n.color}) 16%, var(--trace-surface))` } : undefined}>
                            {n.kind === "entity" ? (n.displayEntity?.name ?? "E").slice(0, 1).toUpperCase() : <ChainIcon chain={n.chain ?? "ethereum"} size={15} />}
                          </span>
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className={cn("truncate text-[13px] leading-snug", mono ? "kit-mono text-[12px]" : "font-medium")}>{mono ? shortAddress(t, 8, 6) : t}</span>
                            <span className="kit-mono truncate text-[11px] leading-snug text-faint">{sub}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Section>
            <Section title="Notes">
              <Notes value={doc.notes} readOnly={readOnly} onSave={props.onNotes} />
            </Section>
          </div>
          <footer className="flex h-9 shrink-0 items-center gap-2 border-t border-border px-3 text-xs text-faint" aria-live="polite">
            {!readOnly ? <span aria-hidden className={cn("size-1.5 rounded-full", props.isSaving ? "bg-accent" : "bg-border-strong")} /> : null}
            <span className={cn(props.isSaving && "text-muted")}>{readOnly ? "View only" : props.isSaving ? "Saving…" : props.lastSavedAt ? `Updated ${formatRelative(props.lastSavedAt)}` : "Saved"}</span>
          </footer>
        </>
      ) : null}
    </aside>
  );
});

/** Autosaves 1.5 s after the last keystroke and on blur; reverts the draft if the save fails. */
function Notes({ value, readOnly, onSave }: { value: string; readOnly: boolean; onSave: (n: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState(value);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!dirty.current) setDraft(value);
  }, [value]);
  const save = async (text: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!dirty.current) return;
    dirty.current = false;
    if (text === value) return;
    const ok = await onSave(text);
    if (!ok) setDraft(value);
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <div className="px-3 pb-3">
      <textarea
        aria-label="Trace notes"
        value={draft}
        readOnly={readOnly}
        maxLength={10000}
        placeholder={readOnly ? "No notes." : "What are you looking for? Findings, hypotheses, next steps."}
        onChange={(e) => {
          setDraft(e.target.value);
          dirty.current = true;
          if (timer.current) clearTimeout(timer.current);
          const text = e.target.value;
          timer.current = setTimeout(() => void save(text), NOTES_DEBOUNCE_MS);
        }}
        onBlur={(e) => void save(e.target.value)}
        className="min-h-28 w-full resize-y rounded-sm border border-border bg-surface px-2 py-1.5 text-[13px] leading-normal placeholder:text-faint focus-visible:border-accent"
      />
    </div>
  );
}
