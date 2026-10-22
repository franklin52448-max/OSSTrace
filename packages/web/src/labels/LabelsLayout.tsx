import { Lock } from "lucide-react";
import type { ReactNode } from "react";
import { useEntities, useTags } from "./api.ts";
import { cn } from "../kit/cn.ts";

export type LabelsTab = "labels" | "entities" | "tags";

/** Labels frame: the three sections as large tabs across the top, the section below. */
export function LabelsLayout({ active, children }: { active: LabelsTab; children: ReactNode }) {
  const entities = useEntities();
  const tags = useTags();
  const tabs: { id: LabelsTab; href: string; label: string; count?: number }[] = [
    { id: "entities", href: "#labels/entities", label: "Entities", count: entities.data?.length },
    { id: "labels", href: "#labels", label: "Labels" },
    { id: "tags", href: "#labels/tags", label: "Tags", count: tags.data?.length },
  ];
  return (
    <div className="flex min-h-full flex-col">
      <div className="border-b border-border px-[var(--trace-page-gutter)]">
        <div className="mx-auto flex w-full max-w-[var(--trace-page-max)] items-end gap-8">
          <nav aria-label="Labels sections" className="-mb-px flex gap-7 overflow-x-auto">
            {tabs.map((t) => (
              <a
                key={t.id}
                href={t.href}
                aria-current={active === t.id ? "page" : undefined}
                className={cn(
                  "kit-fade inline-flex h-14 shrink-0 items-center gap-2 border-b-2 text-[18px] font-medium tracking-[-0.01em]",
                  active === t.id ? "border-accent text-text" : "border-transparent text-faint hover:text-muted",
                )}
              >
                {t.label}
                {t.count != null ? <span className="kit-num text-[12px] font-normal text-faint">{t.count}</span> : null}
              </a>
            ))}
          </nav>
          <p className="ml-auto hidden items-center gap-1.5 pb-4 text-xs text-muted md:flex">
            <Lock aria-hidden className="size-3.5" /> Private to your account · used in every view and alert
          </p>
        </div>
      </div>
      <div className="mx-auto w-full max-w-[var(--trace-page-max)] flex-1 px-[var(--trace-page-gutter)] py-6">{children}</div>
    </div>
  );
}
