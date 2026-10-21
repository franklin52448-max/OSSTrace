import { useState } from "react";
import { signIn, signOut, useSession } from "./session.ts";

const inputClass = "rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm";

/** Log in / sign up / log out, against the real accounts API (`@opentrace/accounts`). */
export default function AccountPanel() {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session.status === "checking") {
    return <div className="mt-3 text-xs text-neutral-500">Checking session…</div>;
  }

  if (session.status === "signed-in" || session.status === "unreachable") {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-neutral-400">
        {session.status === "signed-in" ? (
          <span>
            Signed in as <span className="text-neutral-200">{session.user.email}</span>
            {session.user.role !== "user" && <span className="ml-1 rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300">{session.user.role}</span>}
          </span>
        ) : (
          <span className="text-amber-300">Session not checked: {session.message}</span>
        )}
        <button type="button" onClick={() => void signOut()} className="text-neutral-400 underline hover:text-neutral-200">
          Log out
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="mt-3 text-xs text-neutral-500">
        <button type="button" onClick={() => setOpen(true)} className="text-emerald-400 hover:text-emerald-300">
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
    <form onSubmit={handleSubmit} className="mt-3 rounded-md border border-neutral-800 bg-neutral-900 p-3" aria-label={mode === "login" ? "Log in" : "Sign up"}>
      <div className="mb-2 flex gap-3 text-sm">
        {(["login", "signup"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              setError(null);
            }}
            className={mode === m ? "font-medium text-neutral-100" : "text-neutral-500 hover:text-neutral-300"}
          >
            {m === "login" ? "Log in" : "Sign up"}
          </button>
        ))}
        <button type="button" onClick={() => setOpen(false)} className="ml-auto text-xs text-neutral-500 hover:text-neutral-300">
          Cancel
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        <input
          type="email"
          required
          autoComplete="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={`${inputClass} min-w-0 flex-1`}
        />
        <input
          type="password"
          required
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          minLength={mode === "signup" ? 10 : undefined}
          placeholder={mode === "signup" ? "Password (10+ characters)" : "Password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={`${inputClass} min-w-0 flex-1`}
        />
        <button type="submit" disabled={busy} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50">
          {busy ? "…" : mode === "login" ? "Log in" : "Create account"}
        </button>
      </div>
      {error && <div className="mt-2 text-xs text-red-300">{error}</div>}
      {mode === "signup" && (
        <p className="mt-2 text-xs text-neutral-500">
          Your email is only an identifier: it isn't verified, and there's no password reset by email yet.
        </p>
      )}
    </form>
  );
}
