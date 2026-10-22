import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../kit/cn.ts";

export type MenuItem =
  | { kind: "item"; label: string; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string; icon?: ReactNode }
  | { kind: "swatches"; label: string; items: { key: string; label: string; color: string | null; active: boolean; onSelect: () => void }[] }
  | { kind: "sep" };

/** Floating menu at a client point. Closes on Esc, outside pointerdown, scroll or wheel. Arrow keys move focus. */
export function ContextMenu({ x, y, items, onClose, label }: { x: number; y: number; items: MenuItem[]; onClose: () => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus();
    const down = (e: PointerEvent) => {
      if (!el?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("wheel", onClose, { passive: true });
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("wheel", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const left = Math.min(x, window.innerWidth - 248);
  const top = Math.min(y, window.innerHeight - 40 * items.length - 24);
  const node: ReactNode = (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className="kit-overlay fixed z-[260] w-60 p-1 text-[13px]"
      data-state="open"
      style={{ left, top: Math.max(8, top) }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const all = [...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled]),[role=menuitemradio]") ?? [])];
        const i = all.indexOf(document.activeElement as HTMLElement);
        all[(i + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
      }}
    >
      {items.map((it, i) =>
        it.kind === "sep" ? (
          <div key={i} role="separator" className="my-1 h-px bg-border" />
        ) : it.kind === "swatches" ? (
          <div key={i} className="px-3 py-1.5" role="group" aria-label={it.label}>
            <div className="kit-sect-h mb-2">{it.label}</div>
            <div className="flex flex-wrap gap-1.5">
              {it.items.map((s) => (
                <button key={s.key} type="button" role="menuitemradio" aria-checked={s.active} aria-label={s.label} title={s.label}
                  onClick={() => {
                    s.onSelect();
                    onClose();
                  }}
                  className={cn("size-6 rounded-full border", s.active ? "border-text ring-2 ring-text ring-offset-2 ring-offset-[var(--trace-surface)]" : "border-border-strong")}
                  style={{ background: s.color ?? "var(--trace-surface)" }}
                />
              ))}
            </div>
          </div>
        ) : (
          <button key={i} type="button" role="menuitem" disabled={it.disabled} title={it.hint}
            onClick={() => {
              it.onSelect();
              onClose();
            }}
            className={cn("kit-fade flex h-9 w-full items-center gap-2.5 rounded-sm px-2.5 text-left outline-none hover:bg-surface-2 focus-visible:bg-surface-2 disabled:opacity-45 disabled:hover:bg-transparent", it.danger ? "text-danger hover:bg-danger-soft focus-visible:bg-danger-soft" : "text-text")}>
            {it.icon ? <span aria-hidden className={cn("flex size-4 shrink-0 items-center justify-center [&>svg]:size-3.5", !it.danger && "text-muted")}>{it.icon}</span> : null}
            {it.label}
          </button>
        ),
      )}
    </div>
  );
  return createPortal(node, document.body);
}
