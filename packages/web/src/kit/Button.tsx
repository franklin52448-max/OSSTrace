import { LoaderCircle } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn.ts";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "danger-solid";
type Size = "md" | "sm";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent font-medium text-accent-ink hover:bg-accent-strong active:translate-y-px disabled:opacity-45 disabled:active:translate-y-0",
  secondary: "bg-[var(--helium-elevated-7)] text-text hover:bg-[var(--helium-elevated-10)] active:bg-[var(--helium-elevated-15)] disabled:opacity-50",
  ghost: "text-muted hover:bg-surface-2 hover:text-text active:bg-surface-3 disabled:opacity-40",
  danger: "border border-border bg-surface text-danger hover:border-danger hover:bg-danger-soft disabled:opacity-50",
  "danger-solid": "bg-danger font-semibold text-[var(--trace-surface)] hover:brightness-110 active:translate-y-px disabled:opacity-50",
};
const SIZES: Record<Size, string> = { md: "h-8 px-3 text-[13px] gap-1.5", sm: "h-7 px-2.5 text-xs gap-1.5" };

const BASE = "kit-fade inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-full font-medium";

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
          "kit-fade inline-flex shrink-0 items-center justify-center rounded-full",
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
