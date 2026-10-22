import { useEffect, useRef, useState } from "react";
import { connectEthereum, connectSolana, getEthereumProvider, getSolanaProvider, signEthereumMessage, signSolanaMessage } from "./walletConnect.ts";
import { serverChallenge, serverSignOut, serverVerify, setServerUser, useServerSession, type ServerUser, type WalletChain } from "./serverSession.ts";
import { useUpdateSettings } from "./settings/api.ts";
import { Button, Input, Link, Spinner } from "./prism/components.tsx";
import { IconChevronDown, IconX } from "./prism/icons.tsx";
import { OPEN_LOGIN_EVENT } from "./ui.tsx";

type PanelView = "menu" | "settings";

/** Header account menu: connect a wallet (Phantom/MetaMask), set a display name, log out. Against the new unified server (serverSession.ts) -- the wallet address IS the account; there's no password. */
export default function AccountPanel() {
  const session = useServerSession();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<PanelView>("menu");
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

  // Any view's "Log in" prompt opens this menu on the connect-wallet form.
  useEffect(() => {
    const onOpenLogin = () => {
      setView("menu");
      setOpen(true);
    };
    window.addEventListener(OPEN_LOGIN_EVENT, onOpenLogin);
    return () => window.removeEventListener(OPEN_LOGIN_EVENT, onOpenLogin);
  }, []);

  if (session.status === "checking") {
    return <Spinner size={18} className="text-ink-faint" />;
  }

  const signedIn = session.status === "signed-in" || session.status === "unreachable";
  const label = session.status === "signed-in" ? session.user.displayName : "Session unchecked";

  return (
    <div ref={rootRef} className="relative">
      {signedIn ? (
        <Button
          transparent
          className="small !pl-1.5"
          aria-expanded={open}
          onClick={() => {
            setView("menu");
            setOpen((o) => !o);
          }}
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-helium text-xs font-semibold text-white uppercase">{label[0] ?? "?"}</span>
          <span className="hidden max-w-[10rem] truncate text-ink-dim sm:inline">{label}</span>
          <IconChevronDown className="!h-3.5 !w-3.5 text-ink-faint" />
        </Button>
      ) : (
        <Button
          primary
          className="small"
          onClick={() => {
            setView("menu");
            setOpen(true);
          }}
        >
          Connect wallet
        </Button>
      )}

      {open && (
        <div className="card absolute right-0 top-[calc(100%+10px)] z-40 w-[min(20rem,calc(100vw-2rem))] p-4">
          {session.status === "signed-in" ? (
            view === "settings" ? (
              <SettingsForm user={session.user} onDone={() => setView("menu")} />
            ) : (
              <SignedInMenu user={session.user} onSettings={() => setView("settings")} onClose={() => setOpen(false)} />
            )
          ) : session.status === "unreachable" ? (
            <div className="space-y-3 text-sm">
              <div className="text-warn">Session not checked: {session.message}</div>
              <Button className="w-full" onClick={() => void serverSignOut().then(() => setOpen(false))}>
                Log out
              </Button>
            </div>
          ) : (
            <ConnectForm onDone={() => setOpen(false)} />
          )}
        </div>
      )}
    </div>
  );
}

function SignedInMenu({ user, onSettings, onClose }: { user: ServerUser; onSettings: () => void; onClose: () => void }) {
  return (
    <div className="space-y-3 text-sm">
      <div>
        <div className="text-xs text-ink-faint">Signed in as</div>
        <div className="mt-0.5 break-all font-medium text-ink">{user.displayName}</div>
        {user.walletAddress && (
          <div className="mt-0.5 break-all text-xs text-ink-faint">
            {user.chain === "solana" ? "Solana" : "Ethereum"} · {user.walletAddress}
          </div>
        )}
      </div>
      <Button className="w-full" onClick={onSettings}>
        Settings
      </Button>
      <Button className="w-full" onClick={() => void serverSignOut().then(onClose)}>
        Log out
      </Button>
    </div>
  );
}

function SettingsForm({ user, onDone }: { user: ServerUser; onDone: () => void }) {
  const update = useUpdateSettings();
  const [name, setName] = useState(user.displayName);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a display name.");
      return;
    }
    try {
      const settings = await update.mutateAsync({ displayName: trimmed });
      setServerUser(settings.user);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3" aria-label="Settings">
      <div className="flex items-center gap-1">
        <span className="text-sm font-medium">Settings</span>
        <Button transparent circle className="small ml-auto !text-ink-faint" aria-label="Back" onClick={onDone}>
          <IconX />
        </Button>
      </div>
      <div>
        <label className="mb-1 block text-xs text-ink-faint" htmlFor="account-display-name">
          Display name
        </label>
        <Input id="account-display-name" aria-label="Display name" required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div role="alert" className={error ? "text-xs text-danger" : "sr-only"}>
        {error}
      </div>
      <Button type="submit" primary disabled={update.isPending} className="w-full">
        {update.isPending ? <Spinner size={16} /> : "Save"}
      </Button>
    </form>
  );
}

function ConnectForm({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState<WalletChain | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasPhantom = !!getSolanaProvider();
  const hasMetaMask = !!getEthereumProvider();

  async function connect(chain: WalletChain): Promise<void> {
    setBusy(chain);
    setError(null);
    try {
      let address: string;
      let signature: string;
      if (chain === "solana") {
        const provider = getSolanaProvider();
        if (!provider) throw new Error("Phantom not found");
        address = await connectSolana(provider);
        const challenge = await serverChallenge(chain, address);
        if (!challenge.ok) throw new Error(challenge.message);
        signature = await signSolanaMessage(provider, challenge.body.message);
      } else {
        const provider = getEthereumProvider();
        if (!provider) throw new Error("MetaMask not found");
        address = await connectEthereum(provider);
        const challenge = await serverChallenge(chain, address);
        if (!challenge.ok) throw new Error(challenge.message);
        signature = await signEthereumMessage(provider, address, challenge.body.message);
      }
      const problem = await serverVerify(chain, address, signature);
      if (problem) throw new Error(problem);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't connect");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3" aria-label="Connect wallet">
      <div className="flex items-center gap-1">
        <span className="text-sm font-medium">Connect a wallet</span>
        <Button transparent circle className="small ml-auto !text-ink-faint" aria-label="Close" onClick={onDone}>
          <IconX />
        </Button>
      </div>
      <WalletOption label="Phantom" detected={hasPhantom} installHref="https://phantom.app/download" busy={busy === "solana"} disabled={busy !== null} onClick={() => void connect("solana")} />
      <WalletOption
        label="MetaMask"
        detected={hasMetaMask}
        installHref="https://metamask.io/download/"
        busy={busy === "ethereum"}
        disabled={busy !== null}
        onClick={() => void connect("ethereum")}
      />
      {/* Always mounted, so screen readers already track this live region when the message lands
          in it (a region inserted together with its text isn't reliably announced). Empty, it's
          visually hidden and takes no space. */}
      <div role="alert" className={error ? "text-xs text-danger" : "sr-only"}>
        {error}
      </div>
      <p className="text-xs leading-relaxed text-ink-faint">Your wallet is your account -- nothing is shared except the public address. Pick a display name afterward in Settings.</p>
    </div>
  );
}

function WalletOption({
  label,
  detected,
  installHref,
  busy,
  disabled,
  onClick,
}: {
  label: string;
  detected: boolean;
  installHref: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  if (!detected) {
    return (
      <Link href={installHref} className="button flex w-full items-center justify-between !no-underline">
        <span>{label}</span>
        <span className="text-xs text-ink-faint">Install</span>
      </Link>
    );
  }
  return (
    <Button className="flex w-full items-center justify-between" disabled={disabled} onClick={onClick}>
      <span>{label}</span>
      {busy && <Spinner size={16} />}
    </Button>
  );
}
