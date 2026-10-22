import { cn } from "./cn.ts";

/**
 * Route-driven tabs (each tab is a URL). The caller computes `active` itself (e.g. from the hash
 * route), rather than this component matching a router's location -- OSSTrace has no router
 * library; navigation is the URL hash (see App.tsx). Use Radix Tabs for in-page tabs instead.
 */
export function TabNav({ items, label }: { items: { href: string; label: string; active: boolean; count?: number | null }[]; label: string }) {
  return (
    <nav aria-label={label} className="-mb-px mt-4 flex gap-5 overflow-x-auto">
      {items.map((it) => (
        <a
          key={it.href}
          href={it.href}
          aria-current={it.active ? "page" : undefined}
          className={cn(
            "kit-fade relative inline-flex h-9 shrink-0 items-center gap-2 border-b-2 text-[13px] font-medium",
            it.active ? "border-accent text-text" : "border-transparent text-muted hover:border-border-strong hover:text-text",
          )}
        >
          {it.label}
          {it.count != null ? (
            <span className={cn("kit-num inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] px-1 text-[11px]", it.active ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted")}>
              {it.count}
            </span>
          ) : null}
        </a>
      ))}
    </nav>
  );
}
