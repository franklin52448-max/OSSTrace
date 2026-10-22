import { CircleAlert, Inbox, RefreshCw, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { describeError } from "./errors.ts";
import { Button } from "./Button.tsx";
import { cn } from "./cn.ts";

/** Inline error sentence (API message + provider info). */
export function ErrorText({ error, className }: { error: unknown; className?: string }) {
  const d = describeError(error);
  return (
    <p role="alert" className={cn("flex items-start gap-1.5 text-[13px] text-danger", className)}>
      <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>{d.message}</span>
    </p>
  );
}

/** Block error for a failed query, with retry. Provider errors are styled as warnings: the data exists, the source is down. */
export function ErrorNotice({ error, onRetry, title, className }: { error: unknown; onRetry?: () => void; title?: string; className?: string }) {
  const d = describeError(error);
  const provider = d.code === "provider_error" || d.code === "rate_limited";
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-start justify-between gap-3 rounded-md border px-3 py-2.5 text-[13px]",
        provider ? "border-warn/35 bg-warn-soft" : "border-danger/35 bg-danger-soft",
        className,
      )}
    >
      {provider ? <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" /> : <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />}
      <div className="min-w-0 flex-1">
        <p className={cn("font-medium", provider ? "text-warn" : "text-danger")}>{title ?? (provider ? "Provider unavailable" : "Could not load this")}</p>
        <p className="mt-0.5 text-muted">{d.message}</p>
      </div>
      {onRetry ? (
        <Button size="sm" variant="secondary" icon={<RefreshCw aria-hidden className="size-3" />} onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

/** Static skeleton rows for tables and lists (no shimmer). */
export function SkeletonRows({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div aria-busy="true" aria-label="Loading" className={cn("divide-y divide-border", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-9 items-center gap-4 px-4" style={{ animationDelay: `${i * 80}ms` }}>
          <span className="kit-skeleton h-2.5" style={{ width: `${18 + ((i * 37) % 14)}%` }} />
          <span className="kit-skeleton h-2.5 w-1/6" />
          <span className="kit-skeleton ml-auto h-2.5 w-16" />
        </div>
      ))}
    </div>
  );
}

/** One quiet sentence plus at most one action, centred in the panel it empties. `icon` replaces the default tray. */
export function EmptyState({ title, body, action, className, icon }: { title: string; body?: ReactNode; action?: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <div className={cn("flex flex-col items-center gap-2 px-4 py-12 text-center", className)}>
      <span aria-hidden className="mb-1 inline-flex size-9 items-center justify-center rounded-md border border-border bg-surface-2 text-faint [&>svg]:size-4">
        {icon ?? <Inbox />}
      </span>
      <p className="text-[13.5px] font-semibold text-text">{title}</p>
      {body ? <p className="max-w-[52ch] text-[13px] text-muted">{body}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
