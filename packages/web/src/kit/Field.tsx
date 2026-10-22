import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "./cn.ts";

const control =
  "kit-fade w-full rounded-[var(--radius-ctl)] border border-transparent bg-[var(--helium-elevated-7)] px-3 text-[13px] text-text placeholder:text-faint hover:bg-[var(--helium-elevated-10)] focus-visible:bg-[var(--helium-elevated-10)] focus-visible:outline-offset-0 aria-[invalid=true]:border-danger disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted";

/** Label above, help or error below, wired with aria-describedby. Render-prop gives the control its ids. */
export function Field({
  label,
  help,
  error,
  children,
  className,
  optional,
}: {
  label: ReactNode;
  help?: ReactNode;
  error?: string | null;
  optional?: boolean;
  className?: string;
  children: (p: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode;
}) {
  const id = useId();
  const describedBy = error ? `${id}-err` : help ? `${id}-help` : undefined;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-[12.5px] font-medium text-text">
        {label}
        {optional ? <> <span className="ml-1 font-normal text-faint">(optional)</span></> : null}
      </label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {error ? (
        <p id={`${id}-err`} className="text-xs text-danger">
          {error}
        </p>
      ) : help ? (
        <p id={`${id}-help`} className="text-xs text-muted">
          {help}
        </p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(control, "h-8", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(control, "min-h-20 py-1.5 leading-normal", className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cn(control, "kit-select h-8 cursor-pointer pr-8", className)} {...rest}>
      {children}
    </select>
  );
});

export function Checkbox({ label, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className={cn("inline-flex cursor-pointer items-center gap-2 text-[13px]", className)}>
      <input type="checkbox" className="size-3.5 cursor-pointer accent-[var(--trace-accent)]" {...rest} />
      <span>{label}</span>
    </label>
  );
}
