import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { connectEthereum, connectSolana, getEthereumProvider, getSolanaProvider, signEthereumMessage, signSolanaMessage } from "./walletConnect.ts";
import { serverChallenge, serverSignOut, serverVerify, setServerUser, useServerSession, type ServerUser, type WalletChain } from "./serverSession.ts";
import { useUpdateSettings } from "./settings/api.ts";
import { ChainIcon } from "./ChainSelect.tsx";
import { Button, CopyButton, Spinner, cx } from "./prism/components.tsx";
import { IconArrowLeft, IconChevronDown, IconExternalLink, IconX } from "./prism/icons.tsx";
import { OPEN_LOGIN_EVENT } from "./ui.tsx";

/**
 * Header account control, against the unified server (serverSession.ts). The wallet address is the
 * account: there's no password. Signed out: one "Connect wallet" button that opens the connect
 * dialog. Signed in: a small menu with the wallet, a display-name setting and Log out.
 */
export default function AccountPanel() {
  const session = useServerSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // The signed-in menu closes on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  // Any view's "Log in" prompt opens the connect dialog.
  useEffect(() => {
    const onOpenLogin = () => setConnectOpen(true);
    window.addEventListener(OPEN_LOGIN_EVENT, onOpenLogin);
    return () => window.removeEventListener(OPEN_LOGIN_EVENT, onOpenLogin);
  }, []);

  if (session.status === "checking") {
    return <Spinner size={18} className="text-ink-faint" />;
  }

  if (session.status === "anonymous") {
    return (
      <>
        <Button primary className="small" onClick={() => setConnectOpen(true)}>
          Connect wallet
        </Button>
        {connectOpen && <ConnectDialog onClose={() => setConnectOpen(false)} />}
      </>
    );
  }

  const label = session.status === "signed-in" ? session.user.displayName : "Session unchecked";

  return (
    <div ref={rootRef} className="relative">
      <Button transparent className="small !pl-1.5" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-helium text-xs font-semibold text-white uppercase">{label[0] ?? "?"}</span>
        <span className="hidden max-w-[10rem] truncate text-ink-dim sm:inline">{label}</span>
        <IconChevronDown className="!h-3.5 !w-3.5 text-ink-faint" />
      </Button>

      {menuOpen && (
        <div className="card absolute right-0 top-[calc(100%+10px)] z-40 w-[min(19rem,calc(100vw-2rem))] p-2">
          {session.status === "signed-in" ? (
            <SignedInMenu user={session.user} onClose={() => setMenuOpen(false)} />
          ) : (
            <>
              <div className="px-2.5 pb-2.5 pt-1.5 text-sm text-warn">Session not checked: {session.message}</div>
              <div className="border-t border-line pt-2">
                <MenuRow onClick={() => void serverSignOut().then(() => setMenuOpen(false))}>Log out</MenuRow>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MenuRow({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-[10px] px-2.5 py-2 text-left text-sm font-medium text-ink-dim transition-colors duration-150 hover:bg-[var(--helium-elevated-10)] hover:text-ink"
    >
      {children}
    </button>
  );
}

const shortAddress = (address: string): string => (address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address);

function SignedInMenu({ user, onClose }: { user: ServerUser; onClose: () => void }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <SettingsForm user={user} onDone={() => setEditing(false)} />;
  return (
    <>
      <div className="px-2.5 pb-2.5 pt-1.5">
        <div className="text-xs text-ink-faint">Signed in as</div>
        <div className="mt-0.5 break-all text-sm font-medium text-ink">{user.displayName}</div>
        {user.walletAddress && (
          <div className="mt-2 flex items-center gap-2 rounded-[10px] bg-[var(--helium-elevated-7)] py-1 pl-2.5 pr-1 text-xs">
            {user.chain && <ChainIcon chain={user.chain} size={14} />}
            <span className="hash min-w-0 flex-1 truncate text-ink-dim" title={user.walletAddress}>
              {shortAddress(user.walletAddress)}
            </span>
            <CopyButton value={user.walletAddress} label="Copy wallet address" />
          </div>
        )}
      </div>
      <div className="space-y-0.5 border-t border-line pt-2">
        <MenuRow onClick={() => setEditing(true)}>Settings</MenuRow>
        <MenuRow onClick={() => void serverSignOut().then(onClose)}>Log out</MenuRow>
      </div>
    </>
  );
}

function SettingsForm({ user, onDone }: { user: ServerUser; onDone: () => void }) {
  const update = useUpdateSettings();
  const [name, setName] = useState(user.displayName);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();

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
    <form onSubmit={handleSubmit} className="space-y-3 p-2" aria-label="Settings">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label="Back"
          onClick={onDone}
          className="-ml-1 flex h-7 w-7 items-center justify-center rounded-full text-ink-faint transition-colors duration-150 hover:bg-[var(--helium-elevated-10)] hover:text-ink"
        >
          <IconArrowLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-medium text-ink">Settings</span>
      </div>
      <div>
        <label htmlFor={nameId} className="mb-1.5 block text-sm font-medium text-ink-dim">
          Display name
        </label>
        <input id={nameId} aria-label="Display name" required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} className="ctl w-full" />
        <p className="mt-1.5 text-xs text-ink-faint">Shown in the header and on things you post, like bounties.</p>
      </div>
      <div role="alert" className={error ? "rounded-ctl border border-danger/35 bg-danger/10 px-3 py-2 text-sm text-danger" : "sr-only"}>
        {error}
      </div>
      <button type="submit" disabled={update.isPending} className="btn-accent w-full">
        {update.isPending && <Spinner size={16} />}
        {update.isPending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

/**
 * Connect-a-wallet as a modal dialog. It's portalled to <body> because the sticky header's
 * backdrop-filter would otherwise become the containing block for a fixed overlay. Focus moves into
 * it on open, Tab stays inside, and Escape, ✕ or a backdrop click closes it and returns focus to
 * whatever opened it. A successful connect just closes it: the button that opened it is gone.
 */
function ConnectDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  // Whatever had focus when the dialog opened, read on the first render.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  // Focus goes back only on a real dismissal, never in an effect cleanup: StrictMode re-runs
  // effects on mount, and a cleanup that refocuses the opener would pull focus out of the dialog.
  const dismiss = (): void => {
    opener?.focus();
    onClose();
  };
  // Read through a ref so the keyboard setup below runs once per opening.
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  useEffect(() => {
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    panelRef.current?.querySelector<HTMLElement>("button:not([aria-label='Close']), a")?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        dismissRef.current();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>("button, input, [href]")].filter((el) => !el.hasAttribute("disabled"));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = overflow;
    };
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-[10vh] backdrop-blur-sm"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="card relative w-full max-w-sm p-6 sm:p-7">
        <button
          type="button"
          aria-label="Close"
          onClick={dismiss}
          className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full text-ink-faint transition-colors duration-150 hover:bg-[var(--helium-elevated-10)] hover:text-ink"
        >
          <IconX className="h-4 w-4" />
        </button>
        <h2 id={titleId} className="text-xl font-semibold tracking-tight text-ink">
          Connect a wallet
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-ink-dim">Your wallet is your account. There's no password, and only its public address is shared.</p>
        <ConnectForm onDone={onClose} />
      </div>
    </div>,
    document.body,
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
    <div className="mt-6 space-y-2" aria-label="Connect wallet">
      <WalletOption wallet="phantom" chainName="Solana" detected={hasPhantom} installHref="https://phantom.app/download" busy={busy === "solana"} disabled={busy !== null} onClick={() => void connect("solana")} />
      <WalletOption
        wallet="metamask"
        chainName="Ethereum"
        detected={hasMetaMask}
        installHref="https://metamask.io/download/"
        busy={busy === "ethereum"}
        disabled={busy !== null}
        onClick={() => void connect("ethereum")}
      />
      {/* Always mounted, so screen readers already track this live region when the message lands
          in it (a region inserted together with its text isn't reliably announced). Empty, it's
          visually hidden and takes no space. */}
      <div role="alert" className={error ? "rounded-ctl border border-danger/35 bg-danger/10 px-3 py-2 text-sm text-danger" : "sr-only"}>
        {error}
      </div>
      <p className="pt-2 text-center text-xs leading-relaxed text-ink-faint">
        You'll be asked to sign a one-time message. Signing it costs nothing and sends no transaction. Pick a display name afterwards in Settings.
      </p>
    </div>
  );
}

const WALLET_NAMES = { phantom: "Phantom", metamask: "MetaMask" } as const;

/**
 * One wallet row. Detected, it's a button whose accessible name is just the wallet's name (the
 * chain and status sit beside it, hidden from that name); not installed, it's a link to the
 * wallet's own download page.
 */
function WalletOption({
  wallet,
  chainName,
  detected,
  installHref,
  busy,
  disabled,
  onClick,
}: {
  wallet: keyof typeof WALLET_NAMES;
  chainName: string;
  detected: boolean;
  installHref: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const name = WALLET_NAMES[wallet];
  const rowClass =
    "flex w-full items-center gap-3 rounded-[14px] border border-line px-3.5 py-3 text-left transition-colors duration-150 hover:border-line-strong hover:bg-[var(--helium-elevated-5)] disabled:opacity-60";
  const body = (
    <>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--helium-elevated-10)]">
        <WalletIcon wallet={wallet} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">{name}</span>
        <span className="block text-xs text-ink-faint" aria-hidden="true">
          {chainName}
        </span>
      </span>
    </>
  );

  if (!detected) {
    return (
      <a href={installHref} target="_blank" rel="noopener noreferrer" className={rowClass}>
        {body}
        <span className="flex items-center gap-1 text-xs font-medium text-ink-dim">
          Install
          <IconExternalLink className="h-3.5 w-3.5" />
        </span>
      </a>
    );
  }
  return (
    <button type="button" aria-label={name} className={cx(rowClass, "group")} disabled={disabled} onClick={onClick}>
      {body}
      {busy ? (
        <Spinner size={16} className="text-ink-faint" />
      ) : (
        <span className="text-xs font-medium text-inbound" aria-hidden="true">
          Detected
        </span>
      )}
    </button>
  );
}

/** Wallet marks from Web3 Icons (MIT, see vendor/README.md). */
function WalletIcon({ wallet }: { wallet: keyof typeof WALLET_NAMES }) {
  if (wallet === "phantom") {
    return (
      <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true">
        <path
          fill="#AB9FF2"
          d="M5.13 19.2c2.297 0 4.023-1.92 5.053-3.436a2.9 2.9 0 0 0-.195.994c0 .885.53 1.516 1.574 1.516 1.433 0 2.965-1.208 3.758-2.51a2 2 0 0 0-.083.524c0 .617.362 1.006 1.1 1.006 2.324 0 4.663-3.959 4.663-7.421C21 7.175 19.58 4.8 16.016 4.8 9.752 4.8 3 12.154 3 16.905 3 18.771 4.044 19.2 5.13 19.2m8.729-9.622c0-.671.39-1.141.96-1.141.557 0 .947.47.947 1.14 0 .672-.39 1.155-.947 1.155-.57 0-.96-.483-.96-1.154m2.979 0c0-.671.39-1.141.96-1.141.557 0 .947.47.947 1.14 0 .672-.39 1.155-.947 1.155-.57 0-.96-.483-.96-1.154"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true">
      <path fill="#FF5C16" d="m19.821 19.918-3.877-1.131-2.924 1.712h-2.04l-2.926-1.712-3.875 1.13L3 16.02l1.179-4.327L3 8.034 4.179 3.5l6.056 3.544h3.53L19.821 3.5 21 8.034l-1.179 3.658L21 16.02z" />
      <path fill="#FF5C16" d="m4.18 3.5 6.055 3.547-.24 2.434zm3.875 12.52 2.665 1.99-2.665.777zm2.452-3.286-.512-3.251-3.278 2.21h-.002v.001l.01 2.275 1.33-1.235zM19.82 3.5l-6.056 3.547.24 2.434zm-3.875 12.52-2.665 1.99 2.665.777zm1.339-4.326v-.002zl-3.279-2.21-.512 3.25h2.451l1.33 1.236z" />
      <path fill="#E34807" d="m8.054 18.787-3.875 1.13L3 16.022h5.054zm2.452-6.054.74 4.7-1.026-2.614-3.497-.85 1.33-1.236zm5.44 6.054 3.875 1.13L21 16.022h-5.055zm-2.452-6.054-.74 4.7 1.026-2.614 3.497-.85-1.331-1.236z" />
      <path fill="#FF8D5D" d="m3 16.02 1.179-4.328h2.535l.01 2.276 3.496.85 1.026 2.613-.527.576-2.665-1.989H3zm18 0-1.179-4.328h-2.535l-.01 2.276-3.496.85-1.026 2.613.527.576 2.665-1.989H21zm-7.235-8.976h-3.53l-.24 2.435 1.251 7.95h1.508l1.252-7.95z" />
      <path fill="#661800" d="M4.179 3.5 3 8.034l1.179 3.658h2.535l3.28-2.211zm5.594 10.177H8.625l-.626.6 2.222.54zM19.821 3.5 21 8.034l-1.179 3.658h-2.535l-3.28-2.211zm-5.593 10.177h1.15l.626.6-2.224.541zm-1.209 5.271.262-.94-.527-.575h-1.509l-.527.575.262.94" />
      <path fill="#C0C4CD" d="M13.02 18.948V20.5h-2.04v-1.552z" />
      <path fill="#E7EBF6" d="m8.055 18.785 2.927 1.714v-1.552l-.262-.94zm7.89 0L13.02 20.5v-1.552l.262-.94z" />
    </svg>
  );
}
