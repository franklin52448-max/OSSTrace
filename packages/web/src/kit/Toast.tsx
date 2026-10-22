import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { describeError } from "./errors.ts";

type ToastKind = "success" | "error" | "info";
type ToastItem = { id: number; kind: ToastKind; message: string };
type ToastApi = { success: (m: string) => void; info: (m: string) => void; error: (errOrMessage: unknown) => void };

const Ctx = createContext<ToastApi | null>(null);
const MAX = 3;

/** Bottom-right toasts. Success/info leave after 4s; errors stay until dismissed. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = ++seq.current;
      setItems((xs) => [...xs, { id, kind, message }].slice(-MAX));
      if (kind !== "error") setTimeout(() => dismiss(id), 4000);
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => push("success", m),
      info: (m) => push("info", m),
      error: (e) => push("error", typeof e === "string" ? e : describeError(e).message),
    }),
    [push],
  );
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(380px,calc(100vw-32px))] flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            className="kit-overlay pointer-events-auto flex items-start gap-2.5 px-3 py-2.5 text-[13px]"
            data-state="open"
          >
            {t.kind === "success" ? (
              <CircleCheck aria-hidden className="mt-px size-4 shrink-0 text-in" />
            ) : t.kind === "error" ? (
              <CircleAlert aria-hidden className="mt-px size-4 shrink-0 text-danger" />
            ) : (
              <Info aria-hidden className="mt-px size-4 shrink-0 text-info" />
            )}
            <p className="min-w-0 flex-1 break-words">{t.message}</p>
            <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="kit-fade -mr-1 rounded-sm p-0.5 text-muted hover:bg-surface-2 hover:text-text">
              <X aria-hidden className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useToast outside ToastProvider");
  return v;
}
