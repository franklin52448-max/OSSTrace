import { useEffect, useState } from "react";
import { ACCOUNTS_URL, apiCall, PRIVATE_LABELS_URL, setSession, usePrivateLabelsVersion, useSession, type PrivateLabel } from "./session.ts";
import { LockIcon } from "./PrivateLabelPanel.tsx";

interface AuthResponse {
  user: { id: string; email: string; role: string };
  session: { token: string; expiresAt: string };
}

/**
 * Log in / sign up against the real accounts API (`packages/features/accounts`), or — when signed
 * in — show who you are, your own private labels, and a log-out button.
 */
export default function AccountBar() {
  const session = useSession();

  // On load, confirm a remembered session is still live (it may have been logged out or expired).
  useEffect(() => {
    if (!session) return;
    void apiCall(ACCOUNTS_URL, "GET", "/accounts/me", { token: session.token });
    // Only on first mount / when the token itself changes.
  }, [session?.token]);

  return (
    <section className="mt-4 rounded-md border border-neutral-800 bg-neutral-900/60 px-4 py-3 text-sm" aria-label="Account">
      {session ? <SignedIn email={session.email} token={session.token} /> : <AuthForm />}
    </section>
  );
}

function AuthForm() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-neutral-400">Log in to keep private labels — notes on addresses only you can see.</span>
        <div className="flex gap-2">
          <button type="button" onClick={() => { setMode("login"); setOpen(true); }} className="rounded-md border border-neutral-700 px-3 py-1.5 hover:bg-neutral-800">
            Log in
          </button>
          <button type="button" onClick={() => { setMode("signup"); setOpen(true); }} className="rounded-md border border-neutral-700 px-3 py-1.5 hover:bg-neutral-800">
            Sign up
          </button>
        </div>
      </div>
    );
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const res = await apiCall<AuthResponse>(ACCOUNTS_URL, "POST", mode === "login" ? "/accounts/login" : "/accounts/signup", {
      body: { email, password },
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setPassword("");
    setSession({ token: res.body.session.token, email: res.body.user.email, expiresAt: res.body.session.expiresAt });
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-label={mode === "login" ? "Log in" : "Sign up"}>
      <div className="flex items-center gap-1 text-xs" role="tablist">
        {(["login", "signup"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => { setMode(m); setError(null); }}
            className={mode === m ? "rounded bg-neutral-800 px-2 py-1 text-neutral-100" : "rounded px-2 py-1 text-neutral-400 hover:text-neutral-200"}
          >
            {m === "login" ? "Log in" : "Sign up"}
          </button>
        ))}
        <button type="button" onClick={() => setOpen(false)} className="ml-auto text-neutral-500 hover:text-neutral-300">
          Cancel
        </button>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="flex-1">
          <span className="sr-only">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="email"
            className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2"
          />
        </label>
        <label className="flex-1">
          <span className="sr-only">Password</span>
          <input
            type="password"
            required
            minLength={mode === "signup" ? 10 : undefined}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === "signup" ? "password (10+ characters)" : "password"}
            className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2"
          />
        </label>
        <button type="submit" disabled={busy} className="rounded-md bg-emerald-600 px-4 py-2 font-medium hover:bg-emerald-500 disabled:opacity-50">
          {busy ? "…" : mode === "login" ? "Log in" : "Create account"}
        </button>
      </div>
      {error && <div className="text-xs text-red-300" role="alert">{error}</div>}
    </form>
  );
}

function SignedIn({ email, token }: { email: string; token: string }) {
  const [showLabels, setShowLabels] = useState(false);

  async function logout(): Promise<void> {
    await apiCall(ACCOUNTS_URL, "POST", "/accounts/logout", { token });
    // Signed out locally even if the server was unreachable; the server-side session then just expires.
    setSession(null);
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-neutral-400">
          Signed in as <span className="text-neutral-200">{email}</span>
        </span>
        <div className="flex gap-2">
          <button type="button" onClick={() => setShowLabels((v) => !v)} aria-expanded={showLabels} className="rounded-md border border-violet-800/70 px-3 py-1.5 text-violet-200 hover:bg-violet-950/60">
            My private labels
          </button>
          <button type="button" onClick={logout} className="rounded-md border border-neutral-700 px-3 py-1.5 hover:bg-neutral-800">
            Log out
          </button>
        </div>
      </div>
      {/* Keyed by token so a different session always starts from an empty list, never the last one's. */}
      {showLabels && <MyPrivateLabels key={token} token={token} />}
    </div>
  );
}

function MyPrivateLabels({ token }: { token: string }) {
  const version = usePrivateLabelsVersion();
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "done"; labels: PrivateLabel[] }>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void apiCall<{ labels: PrivateLabel[] }>(PRIVATE_LABELS_URL, "GET", "/private-labels", { token }).then((res) => {
      if (cancelled) return;
      setState(res.ok ? { status: "done", labels: res.body.labels } : { status: "error", message: res.error.message });
    });
    return () => {
      cancelled = true;
    };
  }, [token, version]);

  return (
    <div className="mt-3 border-t border-neutral-800 pt-3">
      <div className="flex items-center gap-1.5 text-xs text-violet-300">
        <LockIcon /> Only you can see these.
      </div>
      {state.status === "loading" && <div className="mt-2 text-xs text-neutral-500">Loading…</div>}
      {state.status === "error" && <div className="mt-2 text-xs text-red-300">{state.message}</div>}
      {state.status === "done" &&
        (state.labels.length === 0 ? (
          <div className="mt-2 text-xs text-neutral-500">No private labels yet. Look up an address to add one.</div>
        ) : (
          <ul className="mt-2 divide-y divide-neutral-800">
            {state.labels.map((l) => (
              <li key={`${l.chain}:${l.address}`} className="flex items-baseline justify-between gap-3 py-1.5">
                <span className="min-w-0 truncate text-violet-100">{l.label}</span>
                <span className="shrink-0 font-mono text-xs text-neutral-500">
                  {l.chain} · {l.address.slice(0, 6)}…{l.address.slice(-4)}
                </span>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
