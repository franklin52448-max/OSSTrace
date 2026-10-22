import type { SyncStatus } from "@osstrace/contract";
import { formatDate } from "./format.ts";

/** Surfaces data provenance: partial/syncing/error are shown, never hidden. */
export function SyncBadge({ sync }: { sync: SyncStatus | undefined }) {
  if (!sync || sync.state === "ready") return null;
  const label = { syncing: "Syncing", partial: "Partial history", error: "Provider error" }[sync.state];
  const detail = [sync.message, sync.coveredFrom ? `Covered from ${formatDate(sync.coveredFrom)}` : null, sync.provider ? `Source: ${sync.provider}` : null]
    .filter(Boolean)
    .join(" · ");
  const color = sync.state === "error" ? "var(--trace-danger)" : "var(--trace-warn)";
  return (
    <span
      title={detail || undefined}
      className="inline-flex h-5 items-center gap-1.5 whitespace-nowrap rounded-[4px] border border-[var(--trace-border)] bg-[var(--trace-surface-2)] px-1.5 text-xs"
      style={{ color }}
    >
      <span aria-hidden className="size-1.5 rounded-full" style={{ background: color }} />
      {label}
      {sync.state === "partial" && sync.coveredFrom ? <span className="text-[var(--trace-text-muted)]">from {formatDate(sync.coveredFrom)}</span> : null}
    </span>
  );
}
