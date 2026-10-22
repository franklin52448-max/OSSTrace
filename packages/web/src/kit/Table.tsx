import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "./cn.ts";

/** Ruled table: hairline rows, mono uppercase headers, numeric columns right-aligned. */
export function Table({ children, className, label }: { children: ReactNode; className?: string; label: string }) {
  return (
    <div className={cn("w-full overflow-x-auto", className)}>
      <table aria-label={label} className="w-full border-collapse text-[13px]">
        {children}
      </table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return <thead className="sticky top-0 z-[1] bg-surface-2">{children}</thead>;
}

export function Th({ className, num, children, ...rest }: ThHTMLAttributes<HTMLTableCellElement> & { num?: boolean }) {
  return (
    <th scope="col" className={cn("kit-colhead h-8 whitespace-nowrap border-b border-border px-3 text-left first:pl-4 last:pr-4", num && "text-right", className)} {...rest}>
      {children}
    </th>
  );
}

export function Tr({ className, selected, ...rest }: HTMLAttributes<HTMLTableRowElement> & { selected?: boolean }) {
  return <tr data-selected={selected || undefined} className={cn("kit-tr", className)} {...rest} />;
}

export function Td({ className, num, ...rest }: TdHTMLAttributes<HTMLTableCellElement> & { num?: boolean }) {
  return <td className={cn("h-9 px-3 align-middle first:pl-4 last:pr-4", num && "kit-num text-right", className)} {...rest} />;
}
