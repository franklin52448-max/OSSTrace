import type { TagRef } from "@osstrace/contract";
import { cn } from "./cn.ts";

export function TagChip({ tag, className }: { tag: Pick<TagRef, "name" | "color">; className?: string }) {
  return (
    <span className={cn("inline-flex h-5 max-w-40 items-center gap-1.5 rounded-[4px] border border-border bg-surface-2 px-1.5 text-xs text-muted", className)}>
      <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: tag.color }} />
      <span className="truncate">{tag.name}</span>
    </span>
  );
}
