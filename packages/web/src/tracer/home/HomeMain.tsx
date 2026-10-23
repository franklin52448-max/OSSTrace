/** Main column of the Tracer / Visualizer homes: the subject heading, one large search that starts the work,
 *  and the most recently edited documents as cards (real list data only). */
import { ChevronRight, Search } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "../../kit/cn.ts";
import { formatRelative } from "../../panels/parts.tsx";
import { SearchResults, type AddTarget } from "../dialogs.tsx";
import type { DocListItem } from "./DocList.tsx";

export function HomeMain(p: {
  title: string;
  /** one line under the heading: what this tool does */
  lede: string;
  searchLabel: string;
  placeholder: string;
  onPick: (t: AddTarget) => void;
  busy?: boolean;
  busyText?: string;
  recent: DocListItem[];
  recentLabel: string;
  /** "trace" / "view" for the untitled fallback */
  noun: string;
  footnote?: ReactNode;
}) {
  const [q, setQ] = useState("");
  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col px-6 pb-16 pt-[min(14vh,120px)]">
      <h2 className="text-[22px] font-semibold tracking-[-0.01em]">{p.title}</h2>
      <p className="mt-1 text-[13px] text-muted">{p.lede}</p>
      <form onSubmit={(e) => e.preventDefault()} className="mt-5" role="search">
        <label className="relative block">
          <span className="sr-only">{p.searchLabel}</span>
          <Search aria-hidden className="pointer-events-none absolute left-4 top-1/2 size-[18px] -translate-y-1/2 text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={p.placeholder}
            autoComplete="off"
            spellCheck={false}
            className="kit-fade h-12 w-full rounded-[var(--trace-radius)] border border-border-strong bg-surface pl-11 pr-4 text-[15px] placeholder:text-faint hover:border-[var(--trace-text-faint)] focus-visible:border-accent"
          />
        </label>
      </form>
      {q.trim() ? (
        <div className="kit-panel mt-2 max-h-[46vh] overflow-y-auto p-1.5">
          <SearchResults q={q} onPick={p.onPick} grouped />
        </div>
      ) : (
        <p className="mt-2 text-xs text-faint">Paste an Ethereum, BNB Chain, Robinhood Chain, Base or Solana address, or type the name of one of your labels or entities.</p>
      )}
      {p.busy ? <p className="mt-2 text-xs text-muted" role="status">{p.busyText}</p> : null}

      {p.recent.length ? (
        <section aria-labelledby="recent-h" className="mt-14">
          <h3 id="recent-h" className="kit-sect-h mb-3">{p.recentLabel}</h3>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {p.recent.map((it) => (
              <li key={it.id}>
                <a href={it.href} className="kit-panel kit-fade group flex h-full items-end gap-2 p-4 hover:border-border-strong focus-visible:border-accent">
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className={cn("truncate text-[14px] font-medium", !it.title && "text-muted")}>{it.title || `Untitled ${p.noun}`}</span>
                    <span className="kit-mono truncate text-[11px] text-faint">Edited {formatRelative(it.updatedAt)}</span>
                    {it.meta ? <span className="kit-mono truncate text-[11px] text-faint">{it.meta}</span> : null}
                  </span>
                  <ChevronRight aria-hidden className="size-4 shrink-0 text-faint group-hover:text-text" />
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {p.footnote ? <div className="mt-6 text-xs text-faint">{p.footnote}</div> : null}
    </div>
  );
}
