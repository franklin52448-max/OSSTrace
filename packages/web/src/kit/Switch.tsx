import * as RSwitch from "@radix-ui/react-switch";
import { cn } from "./cn.ts";

export function Switch({ checked, onCheckedChange, label, disabled, className }: { checked: boolean; onCheckedChange: (v: boolean) => void; label: string; disabled?: boolean; className?: string }) {
  return (
    <RSwitch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "kit-fade relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border border-border-strong bg-surface-3 data-[state=checked]:border-accent data-[state=checked]:bg-accent disabled:opacity-50",
        className,
      )}
    >
      <RSwitch.Thumb className="block size-3 translate-x-[2px] rounded-full bg-muted shadow-[0_1px_2px_rgba(0,0,0,0.3)] transition-transform duration-150 ease-out data-[state=checked]:translate-x-[15px] data-[state=checked]:bg-accent-ink" />
    </RSwitch.Root>
  );
}
