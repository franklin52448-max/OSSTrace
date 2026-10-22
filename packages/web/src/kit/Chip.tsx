import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn.ts";

export type ChipTone = "neutral" | "accent" | "in" | "out" | "warn";

const TONES: Record<ChipTone, string> = {
  neutral: "border-border-strong text-text",
  accent: "border-accent/45 bg-accent-soft text-accent",
  in: "border-in/45 bg-in-soft text-in",
  out: "border-out/45 bg-out-soft text-out",
  warn: "border-warn/45 bg-warn-soft text-warn",
};

/** Filter chip: mono caps key, value, optional remove button. Used for rule filters and active table filters. */
export function Chip({ k, children, tone = "neutral", onRemove, removeLabel, className, title }: { k?: string; children?: ReactNode; tone?: ChipTone; onRemove?: () => void; removeLabel?: string; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("kit-mono inline-flex h-6 max-w-full shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium", TONES[tone], onRemove && "pl-1", className)}>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel ?? `Remove ${k ?? "filter"}`}
          className="kit-fade inline-flex size-4 shrink-0 items-center justify-center rounded-full hover:bg-[color-mix(in_srgb,currentColor_18%,transparent)]"
        >
          <X aria-hidden className="size-3" />
        </button>
      ) : null}
      {k ? <span className="uppercase tracking-[0.06em]">{k}</span> : null}
      {children != null ? <span className="min-w-0 truncate normal-case tracking-normal">{children}</span> : null}
    </span>
  );
}
