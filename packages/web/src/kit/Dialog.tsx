import * as RDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn.ts";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = "md",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: "md" | "lg";
}) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="kit-scrim fixed inset-0 z-40 bg-[var(--trace-scrim)]" />
        <RDialog.Content
          className={cn(
            "kit-overlay fixed left-1/2 top-[10vh] z-50 flex max-h-[80vh] w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-hidden",
            width === "md" ? "max-w-[480px]" : "max-w-[680px]",
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border bg-surface-2 px-5 py-3.5">
            <div className="min-w-0">
              <RDialog.Title className="text-[15px] font-semibold tracking-[-0.005em]">{title}</RDialog.Title>
              {description ? <RDialog.Description className="mt-1 text-[13px] text-muted">{description}</RDialog.Description> : <RDialog.Description className="sr-only">{title}</RDialog.Description>}
            </div>
            <RDialog.Close aria-label="Close" className="kit-fade -mr-1.5 rounded-sm p-1 text-muted hover:bg-surface-3 hover:text-text">
              <X className="size-4" aria-hidden />
            </RDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex items-center justify-end gap-2 border-t border-border bg-surface-2 px-5 py-3">{footer}</div> : null}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
