import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { IconButton } from "./Button.tsx";

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      size="sm"
      label={done ? "Copied" : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked: the value is still selectable on the page */
        }
      }}
    >
      {done ? <Check aria-hidden className="size-3.5 text-in" /> : <Copy aria-hidden className="size-3.5" />}
    </IconButton>
  );
}
