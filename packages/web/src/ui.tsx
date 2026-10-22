// Shared page furniture so every view reads the same way: one header, one notice style, one empty
// state, one sign-in prompt. Views compose these instead of hand-rolling their own boxes.
import type { ReactNode } from "react";
import { cx, Spinner } from "./prism/components.tsx";

export function LockIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" className="shrink-0 fill-current">
      <path d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 12 6h-.5V4.5A3.5 3.5 0 0 0 8 1Zm2 5H6V4.5a2 2 0 1 1 4 0V6Z" />
    </svg>
  );
}

/** Title, one line of context, and the page's own actions on the right. */
export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-dim">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

const NOTICE_TONE = {
  info: "border-line bg-raised/60 text-ink-dim",
  success: "border-signal/30 bg-signal/10 text-ink",
  warn: "border-warn/30 bg-warn/10 text-warn",
  danger: "border-danger/35 bg-danger/10 text-danger",
} as const;

export function Notice({ tone = "info", children, className }: { tone?: keyof typeof NOTICE_TONE; children: ReactNode; className?: string }) {
  return (
    <div
      role={tone === "danger" ? "alert" : undefined}
      className={cx("rounded-ctl border px-3.5 py-2.5 text-sm leading-relaxed", NOTICE_TONE[tone], className)}
    >
      {children}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center px-6 py-12 text-center">
      <div className="text-[15px] font-medium text-ink">{title}</div>
      {children && <p className="mt-1 max-w-md text-sm text-ink-faint">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-ink-faint" aria-busy="true">
      <Spinner size={16} /> {label}
    </div>
  );
}

/** Asks the header's account menu to open on the log-in form (see AccountPanel). */
export const OPEN_LOGIN_EVENT = "osstrace:open-login";
export const openLogin = (): void => {
  window.dispatchEvent(new Event(OPEN_LOGIN_EVENT));
};

/** One consistent "you need an account for this" row, with a button that opens the log-in form. */
export function SignInPrompt({ children, privateNote }: { children: ReactNode; privateNote?: boolean }) {
  return (
    <div className="card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <p className="flex min-w-0 items-center gap-2 text-sm text-ink-dim">
        {privateNote && (
          <span className="text-private">
            <LockIcon />
          </span>
        )}
        {children}
      </p>
      <button type="button" onClick={openLogin} className="btn-outline shrink-0">
        Log in
      </button>
    </div>
  );
}
