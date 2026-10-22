import { LoaderCircle } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn.ts";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "danger-solid";
type Size = "md" | "sm";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent font-semibold text-accent-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] hover:bg-accent-strong active:translate-y-px disabled:opacity-45 disabled:active:translate-y-0",
  secondary: "border border-border bg-surface text-text hover:border-border-strong hover:bg-surface-2 active:bg-surface-3 disabled:opacity-50",
  ghost: "text-muted hover:bg-surface-2 hover:text-text active:bg-surface-3 disabled:opacity-40",
  danger: "border border-border bg-surface text-danger hover:border-danger hover:bg-danger-soft disabled:opacity-50",
  "danger-solid": "bg-danger font-semibold text-[var(--trace-surface)] hover:brightness-110 active:translate-y-px disabled:opacity-50",
};
const SIZES: Record<Size, string> = { md: "h-8 px-3 text-[13px] gap-1.5", sm: "h-7 px-2.5 text-xs gap-1.5" };

const BASE = "kit-fade inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-sm font-medium";

/** Button look for elements that must stay links (navigation): same variants and sizes as Button. */
export const buttonClass = (variant: Variant = "secondary", size: Size = "md", className?: string) => cn(BASE, VARIANTS[variant], SIZES[size], className);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean; icon?: ReactNode };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, icon, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClass(variant, size, className)}
      {...rest}
    >
      {loading ? <LoaderCircle aria-hidden className="size-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
});

/** Square icon-only button; `label` is required and becomes the accessible name and tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: Size; variant?: Variant }>(
  function IconButton({ label, size = "md", variant = "ghost", className, children, type = "button", ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        aria-label={label}
        title={label}
        className={cn(
          "kit-fade inline-flex shrink-0 items-center justify-center rounded-sm",
          VARIANTS[variant],
          size === "md" ? "size-8" : "size-7",
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
