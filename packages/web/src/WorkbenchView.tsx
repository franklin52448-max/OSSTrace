// The new unified server (ADR 0022), reached through the existing web UI: sign in (its own
// cookie-based session, see serverSession.ts — separate from the old accounts API's), look up a
// real address, see its real balances and real recent transfers. This is the first real, working
// connection between this frontend and that backend; Explorer/Visualizer/Tracer themselves still
// run on the old services until they're actually cut over (ADR 0022's later chunks).
import { useCallback, useEffect, useState } from "react";
import type { ChainId } from "@osstrace/core";
import { serverApiCall, serverSignIn, serverSignOut, useServerSession, type ServerUser } from "./serverSession.ts";
import { ChainIcon, ChainSelect } from "./ChainSelect.tsx";
import { EmptyState, Loading, Notice, PageHeader } from "./ui.tsx";
import { Button, Input, SearchBar, Text, cx } from "./prism/components.tsx";

// --- The new server's own response shapes (packages/contract/src/api.ts) ----------------------
interface EntityRef {
  id: string;
  name: string;
}
interface LabelRef {
  id: string;
  name: string;
}
interface AddressInfo {
  address: string;
  chain: ChainId;
  entity?: EntityRef | null;
  label?: LabelRef | null;
  tags?: { id: string; name: string; color: string }[];
}
interface TokenBalance {
  tokenId: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  amount: string;
  usd: number | null;
}
interface BalancesResponse {
  address: AddressInfo;
  balances: TokenBalance[];
  totalUsd: number | null;
  truncated?: boolean;
}
interface Transfer {
  id: string;
  chain: ChainId;
  txHash: string;
  blockTimestamp: string;
  from: AddressInfo;
  to: AddressInfo;
  tokenSymbol: string | null;
  amount: string;
  usd: number | null;
}
interface SyncStatus {
  state: "ready" | "syncing" | "partial" | "error";
  coveredFrom: string | null;
  provider: string;
  message?: string;
}
interface TransfersResponse {
  transfers: Transfer[];
  nextCursor: string | null;
  count: { value: number; capped: boolean };
  sync: SyncStatus;
}

/** A busy address can hold hundreds of (mostly spam) tokens; the server sorts by USD value
 * descending, so showing only the first page is a real top-N, not an arbitrary cut. */
const BALANCES_SHOWN = 20;

const EXPLORERS: Record<ChainId, { name: string; tx: string; address: string }> = {
  ethereum: { name: "Etherscan", tx: "https://etherscan.io/tx/", address: "https://etherscan.io/address/" },
  solana: { name: "Solscan", tx: "https://solscan.io/tx/", address: "https://solscan.io/account/" },
};

export default function WorkbenchView() {
  const session = useServerSession();
  return (
    <div className="space-y-5">
      <PageHeader
        title="Workbench"
        description="Sign in to the new unified server and look up a real address — balances and recent transfers, live."
      />
      {session.status === "checking" ? (
        <Loading label="Checking your session…" />
      ) : session.status === "unreachable" ? (
        <Notice tone="danger">Can't reach the new server: {session.message}</Notice>
      ) : session.status === "anonymous" ? (
        <WorkbenchAuthForm />
      ) : (
        <WorkbenchBody user={session.user} />
      )}
    </div>
  );
}

function WorkbenchAuthForm() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const problem = await serverSignIn(mode === "signup" ? "signup" : "login", username.trim(), password);
    setBusy(false);
    if (problem) setError(problem);
  }

  return (
    <form onSubmit={handleSubmit} className="card max-w-sm space-y-3 p-5" aria-label={mode === "login" ? "Log in" : "Sign up"}>
      <div className="flex items-center gap-1">
        {(["login", "signup"] as const).map((m) => (
          <Button
            key={m}
            transparent={mode !== m}
            className="small"
            type="button"
            onClick={() => {
              setMode(m);
              setError(null);
            }}
          >
            {m === "login" ? "Log in" : "Sign up"}
          </Button>
        ))}
      </div>
      <Input aria-label="Workbench username" required autoComplete="username" placeholder="Username (3-32 chars)" value={username} onChange={(e) => setUsername(e.target.value)} />
      <Input
        type="password"
        aria-label="Workbench password"
        required
        autoComplete={mode === "signup" ? "new-password" : "current-password"}
        placeholder={mode === "signup" ? "Password (10+ chars)" : "Password"}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error && (
        <div role="alert" className="text-sm text-danger">
          {error}
        </div>
      )}
      <Button primary type="submit" disabled={busy} className="w-full">
        {busy ? "…" : mode === "login" ? "Log in" : "Sign up"}
      </Button>
    </form>
  );
}

function WorkbenchBody({ user }: { user: ServerUser }) {
  const [chain, setChain] = useState<ChainId>("ethereum");
  const [address, setAddress] = useState("");
  const [target, setTarget] = useState<{ chain: ChainId; address: string } | null>(null);

  return (
    <div className="space-y-5">
      <div className="card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <span className="text-sm text-ink-dim">
          Signed in as <span className="font-medium text-ink">{user.username}</span>
        </span>
        <Button className="small" onClick={() => void serverSignOut()}>
          Log out
        </Button>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = address.trim();
          if (trimmed) setTarget({ chain, address: trimmed });
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <ChainSelect value={chain} onChange={setChain} />
        <SearchBar
          aria-label="Search an address on the Workbench"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder={chain === "ethereum" ? "Search address (0x…)" : "Search Solana address"}
          className="hash"
          width="min(28rem, 100%)"
          spellCheck={false}
        />
        <Button primary type="submit">
          Look up
        </Button>
      </form>

      {target && <WorkbenchResult key={`${target.chain}:${target.address}`} chain={target.chain} address={target.address} />}
    </div>
  );
}

type FetchState<T> = { status: "loading" } | { status: "error"; message: string } | { status: "done"; data: T };

function WorkbenchResult({ chain, address }: { chain: ChainId; address: string }) {
  const [info, setInfo] = useState<FetchState<AddressInfo>>({ status: "loading" });
  const [balances, setBalances] = useState<FetchState<BalancesResponse>>({ status: "loading" });
  const [transfers, setTransfers] = useState<FetchState<TransfersResponse>>({ status: "loading" });

  const load = useCallback(async () => {
    setInfo({ status: "loading" });
    setBalances({ status: "loading" });
    setTransfers({ status: "loading" });
    const encoded = encodeURIComponent(address);

    void serverApiCall<AddressInfo>(`/api/address/${chain}/${encoded}`).then((r) =>
      setInfo(r.ok ? { status: "done", data: r.body } : { status: "error", message: r.message }),
    );
    void serverApiCall<BalancesResponse>(`/api/address/${chain}/${encoded}/balances`).then((r) =>
      setBalances(r.ok ? { status: "done", data: r.body } : { status: "error", message: r.message }),
    );
    void serverApiCall<TransfersResponse>(`/api/transfers?base=${chain}:${encoded}&limit=20`).then((r) =>
      setTransfers(r.ok ? { status: "done", data: r.body } : { status: "error", message: r.message }),
    );
  }, [chain, address]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="card flex items-center gap-3 p-4">
        <ChainIcon chain={chain} size={28} />
        <div className="min-w-0">
          <div className="hash truncate text-sm text-ink">{address}</div>
          {info.status === "done" && (info.data.label || info.data.entity) && (
            <div className="mt-0.5 text-xs text-ink-dim">{info.data.entity?.name ?? info.data.label?.name}</div>
          )}
          {info.status === "error" && <div className="mt-0.5 text-xs text-danger">{info.message}</div>}
        </div>
        <a href={`${EXPLORERS[chain].address}${address}`} target="_blank" rel="noopener noreferrer" className="ml-auto shrink-0 text-xs text-ink-faint underline decoration-line-strong underline-offset-2 hover:text-ink-dim">
          {EXPLORERS[chain].name} ↗
        </a>
      </div>

      <div className="card overflow-hidden">
        <div className="card-header">
          <Text variant="subheading" tag="h2">
            Balances
          </Text>
        </div>
        {balances.status === "loading" ? (
          <Loading />
        ) : balances.status === "error" ? (
          <Notice tone="danger" className="m-4">
            {balances.message}
          </Notice>
        ) : balances.data.balances.length === 0 ? (
          <EmptyState title="No balances found">This address holds no tokens this server has found yet.</EmptyState>
        ) : (
          <>
            <table className="w-full text-sm">
              <tbody>
                {/* Server already sorts by USD value descending, so the first BALANCES_SHOWN rows are the highest-value ones. */}
                {balances.data.balances.slice(0, BALANCES_SHOWN).map((b) => (
                  <tr key={b.tokenId} className="border-t border-line first:border-t-0">
                    <td className="px-4 py-2.5 font-medium text-ink">{b.symbol ?? b.name ?? b.tokenId.slice(0, 10)}</td>
                    <td className="num px-4 py-2.5 text-right text-ink-dim">{b.amount}</td>
                    <td className="num px-4 py-2.5 text-right text-ink-faint">{b.usd !== null ? `$${b.usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {balances.data.balances.length > BALANCES_SHOWN && (
              <div className="border-t border-line px-4 py-2.5 text-xs text-ink-faint">
                + {balances.data.balances.length - BALANCES_SHOWN} more token{balances.data.balances.length - BALANCES_SHOWN === 1 ? "" : "s"} not shown, by value
                {balances.data.truncated ? ` (the server itself capped this address at ${balances.data.balances.length} of more it found)` : ""}
              </div>
            )}
          </>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="card-header">
          <Text variant="subheading" tag="h2">
            Recent transfers
          </Text>
          {transfers.status === "done" && transfers.data.sync.state !== "ready" && (
            <span className="chip border-warn/35 bg-warn/10 text-warn">{transfers.data.sync.state}</span>
          )}
        </div>
        {transfers.status === "loading" ? (
          <Loading />
        ) : transfers.status === "error" ? (
          <Notice tone="danger" className="m-4">
            {transfers.message}
          </Notice>
        ) : transfers.data.transfers.length === 0 ? (
          <EmptyState title="No transfers found">
            {transfers.data.sync.state === "ready" ? "This address has no transfer history this server could find." : (transfers.data.sync.message ?? "The server hasn't finished syncing this address yet.")}
          </EmptyState>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {transfers.data.transfers.map((t) => {
                const outbound = t.from.address.toLowerCase() === address.toLowerCase();
                return (
                  <tr key={t.id} className="border-t border-line first:border-t-0">
                    <td className="px-4 py-2.5 text-xs text-ink-faint">{new Date(t.blockTimestamp).toLocaleString()}</td>
                    <td className={cx("px-4 py-2.5", outbound ? "text-outbound" : "text-inbound")}>{outbound ? "Out" : "In"}</td>
                    <td className="num px-4 py-2.5 text-right text-ink-dim">
                      {t.amount} {t.tokenSymbol ?? ""}
                    </td>
                    <td className="num px-4 py-2.5 text-right text-ink-faint">{t.usd !== null ? `$${t.usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}</td>
                    <td className="px-4 py-2.5 text-right">
                      <a href={`${EXPLORERS[chain].tx}${t.txHash}`} target="_blank" rel="noopener noreferrer" className="hash text-xs text-ink-faint underline decoration-line-strong underline-offset-2 hover:text-ink-dim">
                        {t.txHash.slice(0, 8)}…
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
