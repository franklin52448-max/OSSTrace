import type { ReactNode } from "react";
import { cn } from "./cn.ts";

/** The statement header: subject in sans, metadata line in mono beneath, actions on the right. Sits on the ground, ruled underneath. */
export function PageHeader({ title, meta, actions, className, children }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode; className?: string; children?: ReactNode }) {
  return (
    <header className={cn("border-b border-border px-4 pt-6 xl:px-6", children ? "pb-0" : "pb-5", className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="truncate text-[22px] font-semibold leading-tight tracking-[-0.015em]">{title}</h1>
          {meta ? <div className="kit-mono mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted [&>*+*]:before:mr-2 [&>*+*]:before:text-faint [&>*+*]:before:content-['·']">{meta}</div> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}
