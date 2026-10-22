import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "./cn.ts";

/** A raised surface that holds one job (table, form section, inspector). See DESIGN.md "Panels hold jobs". */
export function Panel({ className, ...rest }: HTMLAttributes<HTMLElement> & { as?: never }) {
  return <section className={cn("kit-panel", className)} {...rest} />;
}

/** Panel header strip: a mono caps title (or tabs) on the left, meta/actions on the right. */
export function PanelHead({ title, titleId, meta, children, className }: { title?: ReactNode; titleId?: string; meta?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("kit-panel-head", className)}>
      {title ? (
        <h2 id={titleId} className="kit-panel-title">
          {title}
        </h2>
      ) : null}
      {children}
      {meta ? <div className="kit-mono ml-auto flex flex-wrap items-center gap-x-2 text-xs text-muted">{meta}</div> : null}
    </div>
  );
}

/** Filter/search row at the top of a table panel, on the panel's own surface. */
export function PanelToolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5", className)}>{children}</div>;
}
