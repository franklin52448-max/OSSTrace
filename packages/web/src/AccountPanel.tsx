import { useEffect, useRef, useState } from "react";
import { signIn, signOut, useSession } from "./session.ts";
import { Button, Input, Spinner } from "./prism/components.tsx";
import { IconChevronDown, IconX } from "./prism/icons.tsx";

/** Header account menu: log in / sign up / log out, against the real accounts API (`@osstrace/accounts`). */
export default function AccountPanel() {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"login" | "signup">("login");
  const rootRef = useRef<HTMLDivElement>(null);

  // Close the popover on an outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (session.status === "checking") {
    return <Spinner size={18} className="text-ink-faint" />;
  }

  const signedIn = session.status === "signed-in" || session.status === "unreachable";

  return (
    <div ref={rootRef} className="relative">
      {signedIn ? (
        <Button transparent className="small !pl-1.5" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-helium text-xs font-semibold text-white uppercase">
            {session.status === "signed-in" ? session.user.email[0] : "?"}
          </span>
          <span className="hidden max-w-[10rem] truncate text-ink-dim sm:inline">
            {session.status === "signed-in" ? session.user.email : "Session unchecked"}
          </span>
          <IconChevronDown className="!h-3.5 !w-3.5 text-ink-faint" />
        </Button>
      ) : (
        <div className="flex items-center gap-1.5">
          <Button
            transparent
            className="small"
            onClick={() => {
              setMode("login");
              setOpen(true);
            }}
          >
            Log in
          </Button>
          <Button
            primary
            className="small"
            onClick={() => {
              setMode("signup");
              setOpen(true);
            }}
          >
            Sign up
          </Button>
        </div>
      )}

      {open && (
        <div className="card absolute right-0 top-[calc(100%+10px)] z-40 w-[min(20rem,calc(100vw-2rem))] p-4">
          {session.status === "signed-in" ? (
            <div className="space-y-3 text-sm">
              <div>
                <div className="text-xs text-ink-faint">Signed in as</div>
                <div className="mt-0.5 break-all font-medium text-ink">{session.user.email}</div>
                {session.user.role !== "user" && (
                  <span className="chip mt-1.5 border-info/35 bg-info/10 text-info">{session.user.role}</span>
                )}
              </div>
              <Button className="w-full" onClick={() => void signOut().then(() => setOpen(false))}>
                Log out
              </Button>
            </div>
          ) : session.status === "unreachable" ? (
            <div className="space-y-3 text-sm">
              <div className="text-warn">Session not checked: {session.message}</div>
              <Button className="w-full" onClick={() => void signOut().then(() => setOpen(false))}>
                Log out
              </Button>
            </div>
          ) : (
            <AuthForm mode={mode} setMode={setMode} onDone={() => setOpen(false)} />
          )}
        </div>
      )}
    </div>
  );
}

function AuthForm({ mode, setMode, onDone }: { mode: "login" | "signup"; setMode: (m: "login" | "signup") => void; onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    onDone();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3" aria-label={mode === "login" ? "Log in" : "Sign up"}>
      <div className="flex items-center gap-1">
        {(["login", "signup"] as const).map((m) => (
          <Button
            key={m}
            transparent={mode !== m}
            className="small"
            onClick={() => {
              setMode(m);
              setError(null);
            }}
          >
            {m === "login" ? "Log in" : "Sign up"}
          </Button>
        ))}
        <Button transparent circle className="small ml-auto !text-ink-faint" aria-label="Close" onClick={onDone}>
          <IconX />
        </Button>
      </div>
      <Input
        type="email"
        aria-label="Email"
        required
        autoComplete="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <Input
        type="password"
        aria-label="Password"
        required
        autoComplete={mode === "login" ? "current-password" : "new-password"}
        minLength={mode === "signup" ? 10 : undefined}
        placeholder={mode === "signup" ? "Password (10+ characters)" : "Password"}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <Button type="submit" primary disabled={busy} className={"w-full"}>
        {busy ? <Spinner size={16} /> : mode === "login" ? "Log in" : "Create account"}
      </Button>
      {error && <div className="text-xs text-danger">{error}</div>}
      {mode === "signup" && (
        <p className="text-xs leading-relaxed text-ink-faint">
          Your email is only an identifier: it isn't verified, and there's no password reset by email yet.
        </p>
      )}
    </form>
  );
}
