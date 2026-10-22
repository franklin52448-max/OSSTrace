import { useState } from "react";
import { signIn, signOut, useSession } from "./session.ts";

/** Log in / sign up / log out, against the real accounts API (`@osstrace/accounts`). */
export default function AccountPanel() {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session.status === "checking") {
    return <div className="text-xs text-ink-faint">Checking session…</div>;
  }

  if (session.status === "signed-in" || session.status === "unreachable") {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-ink-dim">
        {session.status === "signed-in" ? (
          <span className="min-w-0">
            <span className="text-ink-faint">Signed in as </span>
            <span className="break-all font-medium text-ink">{session.user.email}</span>
            {session.user.role !== "user" && (
              <span className="chip ml-1.5 border-info/35 bg-info/10 text-info align-middle">{session.user.role}</span>
            )}
          </span>
        ) : (
          <span className="text-warn">Session not checked: {session.message}</span>
        )}
        <button
          type="button"
          onClick={() => void signOut()}
          className="ml-auto text-ink-faint underline decoration-line-strong underline-offset-2 transition-colors duration-150 hover:text-ink"
        >
          Log out
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="text-xs text-ink-faint">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="font-medium text-signal transition-colors duration-150 hover:text-[#53e6a6] hover:underline underline-offset-2"
        >
          Log in or sign up
        </button>{" "}
        to suggest labels.
      </div>
    );
  }

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const problem = await signIn(mode, email.trim(), password);
    setBusy(false);
    if (problem) {
      setError(problem);
      return;
    }
    setPassword("");
    setOpen(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2.5" aria-label={mode === "login" ? "Log in" : "Sign up"}>
      <div className="flex items-center gap-1 text-sm">
        {(["login", "signup"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              setError(null);
            }}
            className={
              mode === m
                ? "rounded-chip px-2 py-1 font-medium text-ink transition-colors duration-150"
                : "rounded-chip px-2 py-1 text-ink-faint transition-colors duration-150 hover:text-ink-dim"
            }
          >
            {m === "login" ? "Log in" : "Sign up"}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="ml-auto text-xs text-ink-faint transition-colors duration-150 hover:text-ink-dim"
        >
          Cancel
        </button>
      </div>
      {/* Visible labels wrapping their inputs, the same pattern as LabelSubmitForm. */}
      <label className="block text-xs font-medium text-ink-dim">
        Email
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="ctl mt-1 w-full"
        />
      </label>
      <label className="block text-xs font-medium text-ink-dim">
        Password
        {mode === "signup" && <span className="font-normal text-ink-faint"> (10+ characters)</span>}
        <input
          type="password"
          required
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          minLength={mode === "signup" ? 10 : undefined}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="ctl mt-1 w-full"
        />
      </label>
      <button type="submit" disabled={busy} className="btn-accent w-full">
        {busy ? "…" : mode === "login" ? "Log in" : "Create account"}
      </button>
      {/* Always mounted, so screen readers already track this live region when the message lands
          in it (a region inserted together with its text isn't reliably announced). Empty, it's
          visually hidden and takes no space. */}
      <div role="alert" className={error ? "text-xs text-danger" : "sr-only"}>
        {error}
      </div>
      {mode === "signup" && (
        <p className="text-xs leading-relaxed text-ink-faint">
          Your email is only an identifier: it isn't verified, and there's no password reset by email yet.
        </p>
      )}
    </form>
  );
}
