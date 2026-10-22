import { useEffect, useState, type ReactElement } from "react";
import type { ChainId } from "@osstrace/core";
import GraphView from "./GraphView.tsx";
import TracerView from "./TracerView.tsx";
import PrivateLabelPanel from "./PrivateLabelPanel.tsx";
import AccountPanel from "./AccountPanel.tsx";
import ModerationView from "./ModerationView.tsx";
import { LabelSubmitForm, ReviewBadge, SubmissionByline, type LabelView } from "./LabelReview.tsx";
import { isModerator, useSession } from "./session.ts";

const EXPLORER_URL = import.meta.env["VITE_EXPLORER_URL"] ?? "http://localhost:5300";

interface Balance {
  native: { symbol: string; amount: string; decimals: number };
  asOf: string;
}
type Direction = "in" | "out" | "self";
interface TokenTransfer {
  token: string | null;
  symbol: string | null;
  decimals: number | null;
  rawAmount: string;
  amount: string | null;
  direction: Direction;
}
interface TransactionSummary {
  hash: string;
  timestamp: string;
  from: string;
  to: string | null;
  valueNative: string;
  direction: Direction;
  tokenTransfers?: TokenTransfer[];
}

const directionClass = (d: Direction): string => (d === "in" ? "text-inbound" : d === "out" ? "text-outbound" : "text-ink-faint");
const directionSign = (d: Direction): string => (d === "in" ? "+" : d === "out" ? "-" : "");
const shortId = (id: string): string => (id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id);

/** Symbol when the data source gave one, else the token's own address/mint, shortened — never a guessed name. */
function tokenLabel(t: TokenTransfer): string {
  const unit = t.symbol ?? (t.token ? shortId(t.token) : "unknown token");
  return t.amount !== null ? `${t.amount} ${unit}` : `${t.rawAmount} raw units of ${unit}`;
}
type TransactionsResult = { available: true; transactions: TransactionSummary[] } | { available: false; reason: string };
type Label = LabelView;
interface Tag {
  tag: string;
  source: { description: string; url: string; addedAt: string };
}
interface AddressReport {
  address: { chain: ChainId; value: string };
  balance: Balance;
  transactions: TransactionsResult;
  label: Label | null;
  tags: Tag[];
}

type LookupState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; report: AddressReport; chain: ChainId; address: string };

type View = "lookup" | "graph" | "trace" | "moderation";

function viewFromHash(): View {
  if (window.location.hash === "#graph") return "graph";
  if (window.location.hash === "#trace") return "trace";
  if (window.location.hash === "#moderation") return "moderation";
  return "lookup";
}

/** Original mark: three linked nodes — the queried address and two counterparties. */
function Wordmark() {
  return (
    <span className="flex items-center gap-2.5">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" className="shrink-0">
        <path d="M7.4 10.6 16 6.4M7.4 13.4 16 17.6" stroke="var(--color-signal)" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
        <circle cx="5.5" cy="12" r="3" fill="var(--color-signal)" />
        <circle cx="18" cy="5.5" r="2.2" fill="none" stroke="var(--color-ink-dim)" strokeWidth="1.5" />
        <circle cx="18" cy="18.5" r="2.2" fill="none" stroke="var(--color-ink-dim)" strokeWidth="1.5" />
      </svg>
      <span className="text-[15px] font-semibold tracking-tight text-ink">
        OSSTrace
      </span>
    </span>
  );
}

const TAB_ICONS: Record<View, ReactElement> = {
  lookup: (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" className="shrink-0">
      <circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  graph: (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" className="shrink-0">
      <path d="M4.6 5.8 11 3.4M4.6 10.2 11 12.6" stroke="currentColor" strokeWidth="1.3" opacity="0.75" />
      <circle cx="3.6" cy="8" r="2" fill="currentColor" />
      <circle cx="12.4" cy="3" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12.4" cy="13" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  ),
  trace: (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" className="shrink-0">
      <path d="M2.8 11.2 6 6.4 10 9.6l3.2-5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="2.8" cy="11.2" r="1.3" fill="currentColor" />
      <circle cx="6" cy="6.4" r="1.3" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="10" cy="9.6" r="1.3" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="13.2" cy="4.6" r="1.3" fill="currentColor" />
    </svg>
  ),
  moderation: (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" className="shrink-0">
      <path d="M8 1.8 13 3.6v4.1c0 3.1-2.1 5.6-5 6.5-2.9-.9-5-3.4-5-6.5V3.6L8 1.8Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="m5.8 7.9 1.6 1.6 2.9-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

export default function App() {
  const [view, setView] = useState<View>(viewFromHash);
  const session = useSession();

  useEffect(() => {
    const onHashChange = () => setView(viewFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <div className="min-h-screen bg-ground text-ink">
      <div className="mx-auto flex min-h-screen w-full max-w-[104rem] flex-col lg:flex-row">
        {/* App rail: wordmark + view nav + account. On mobile it stacks as a top band. */}
        <aside className="flex w-full shrink-0 flex-col border-b border-line bg-panel/70 lg:sticky lg:top-0 lg:h-screen lg:w-60 lg:border-b-0 lg:border-r">
          <div className="px-5 pt-5 pb-4">
            <a
              href="#"
              onClick={() => setView("lookup")}
              className="inline-flex rounded-md transition-opacity duration-150 hover:opacity-85"
            >
              <Wordmark />
            </a>
            <p className="mt-2 text-xs leading-relaxed text-ink-faint">
              Open-source on-chain lookup — real data, sourced labels. No affiliation with any proprietary platform.
            </p>
          </div>

          <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:pb-0" aria-label="Views">
            {(
              [
                { id: "lookup", label: "Lookup", href: "#" },
                { id: "graph", label: "Graph", href: "#graph" },
                { id: "trace", label: "Trace", href: "#trace" },
                { id: "moderation", label: "Moderation", href: "#moderation" },
              ] as const
            )
              .filter((tab) => tab.id !== "moderation" || isModerator(session) || view === "moderation")
              .map((tab) => (
                <a
                  key={tab.id}
                  href={tab.href}
                  onClick={() => setView(tab.id)}
                  aria-current={view === tab.id ? "page" : undefined}
                  className={
                    view === tab.id
                      ? "flex shrink-0 items-center gap-2.5 rounded-ctl border border-signal/25 bg-signal/10 px-3 py-2 text-sm font-medium text-ink transition-colors duration-150"
                      : "flex shrink-0 items-center gap-2.5 rounded-ctl border border-transparent px-3 py-2 text-sm text-ink-dim transition-colors duration-150 hover:bg-raised hover:text-ink"
                  }
                >
                  <span className={view === tab.id ? "text-signal" : "text-ink-faint"}>{TAB_ICONS[tab.id]}</span>
                  {tab.label}
                </a>
              ))}
          </nav>

          <div className="mt-auto border-t border-line px-4 py-4">
            <AccountPanel />
          </div>
        </aside>

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
          {view === "graph" ? (
            <GraphView />
          ) : view === "trace" ? (
            <TracerView />
          ) : view === "moderation" ? (
            <ModerationView />
          ) : (
            <div className="mx-auto w-full max-w-4xl">
              <Lookup />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function Lookup() {
  const [chain, setChain] = useState<ChainId>("ethereum");
  const [address, setAddress] = useState("");
  const [state, setState] = useState<LookupState>({ status: "idle" });

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = address.trim();
    if (!trimmed) return;
    setState({ status: "loading" });
    try {
      const res = await fetch(`${EXPLORER_URL}/address/${chain}/${encodeURIComponent(trimmed)}`);
      const body = (await res.json()) as AddressReport | { error: string };
      if (!res.ok || "error" in body) {
        setState({ status: "error", message: "error" in body ? body.error : `HTTP ${res.status}` });
        return;
      }
      setState({ status: "done", report: body, chain, address: trimmed });
    } catch (cause) {
      setState({ status: "error", message: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  return (
    <div>
      <form onSubmit={handleSubmit} className="card flex flex-col gap-2 p-3 sm:flex-row">
        <select value={chain} onChange={(e) => setChain(e.target.value as ChainId)} className="ctl shrink-0">
          <option value="ethereum">Ethereum</option>
          <option value="solana">Solana</option>
        </select>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder={chain === "ethereum" ? "0x…" : "a Solana address"}
          aria-label="Address to look up"
          className="ctl hash min-w-0 flex-1"
        />
        <button type="submit" disabled={state.status === "loading"} className="btn-accent shrink-0">
          {state.status === "loading" ? "Looking up…" : "Look up"}
        </button>
      </form>

      {state.status === "error" && (
        <div
          role="alert"
          className="mt-4 rounded-card border border-danger/35 bg-danger/10 px-4 py-3 text-sm text-danger"
        >
          {state.message}
        </div>
      )}

      {state.status === "done" && (
        <Report
          report={state.report}
          chain={state.chain}
          address={state.address}
          onLabelSubmitted={() => void refresh(state.report)}
        />
      )}
    </div>
  );

  /** Re-fetch after a label submission, without blanking the report while it loads. */
  async function refresh(report: AddressReport): Promise<void> {
    try {
      const res = await fetch(`${EXPLORER_URL}/address/${report.address.chain}/${encodeURIComponent(report.address.value)}`);
      const body = (await res.json()) as AddressReport | { error: string };
      if (res.ok && !("error" in body)) {
        setState({ status: "done", report: body, chain: report.address.chain, address: report.address.value });
      }
    } catch {
      // Keep showing the report we have; the next manual lookup will retry.
    }
  }
}

function Report({
  report,
  chain,
  address,
  onLabelSubmitted,
}: {
  report: AddressReport;
  chain: ChainId;
  address: string;
  onLabelSubmitted: () => void;
}) {
  const sanctioned = report.tags.some((t) => t.tag === "sanctioned");
  return (
    <div className="mt-5 space-y-4">
      {/* Queried address header — the real chain + address from the response. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="chip border-line-strong bg-raised text-ink-dim">{chain}</span>
        <span className="hash min-w-0 break-all text-sm text-ink-dim">{address}</span>
      </div>

      <PrivateLabelPanel chain={chain} address={address} />

      {report.label && (
        <section className="card p-4" aria-label="Public label">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-ink">{report.label.name}</h2>
            <span className="chip border-line-strong bg-raised text-ink-dim">{report.label.confidence}</span>
            <ReviewBadge label={report.label} />
            {sanctioned && <span className="chip border-danger/40 bg-danger/15 text-danger">SANCTIONED</span>}
          </div>
          <a
            href={report.label.source.url}
            target="_blank"
            rel="noreferrer"
            className="mt-1.5 block text-xs text-ink-faint underline decoration-line-strong underline-offset-2 transition-colors duration-150 hover:text-ink-dim"
          >
            Source: {report.label.source.description} · added {report.label.source.addedAt}
          </a>
          <SubmissionByline label={report.label} />
        </section>
      )}

      <LabelSubmitForm chain={report.address.chain} address={report.address.value} onSubmitted={onLabelSubmitted} />

      <section className="card p-4" aria-label="Balance">
        <div className="section-title">Balance</div>
        <div className="num mt-1.5 font-mono text-2xl font-semibold tracking-tight text-ink">
          {report.balance.native.amount} <span className="text-base font-medium text-ink-dim">{report.balance.native.symbol}</span>
        </div>
        <div className="mt-1 text-xs text-ink-faint">as of {new Date(report.balance.asOf).toLocaleString()}</div>
      </section>

      <section className="card overflow-hidden" aria-label="Recent transactions">
        <div className="card-header">
          <h2 className="section-title">Recent transactions</h2>
          {report.transactions.available && (
            <span className="num text-xs text-ink-faint">{report.transactions.transactions.length} shown</span>
          )}
        </div>
        {!report.transactions.available ? (
          <div className="px-4 py-3 text-sm text-ink-dim">Unavailable — {report.transactions.reason}</div>
        ) : report.transactions.transactions.length === 0 ? (
          <div className="px-4 py-3 text-sm text-ink-dim">No recent transactions found.</div>
        ) : (
          <ul className="divide-y divide-line">
            {report.transactions.transactions.map((tx) => (
              <li
                key={tx.hash}
                className="flex items-center justify-between gap-4 px-4 py-3 transition-colors duration-150 hover:bg-raised/60"
              >
                <div className="min-w-0">
                  <div className="hash truncate text-xs text-ink-dim">{tx.hash}</div>
                  <div className="mt-0.5 text-xs text-ink-faint">{new Date(tx.timestamp).toLocaleString()}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className={`num font-mono text-sm font-medium ${directionClass(tx.direction)}`}>
                    {directionSign(tx.direction)}
                    {tx.valueNative} <span className="text-xs font-normal text-ink-faint">{report.balance.native.symbol}</span>
                  </div>
                  {tx.tokenTransfers?.map((t, i) => (
                    <div key={i} className={`num mt-0.5 font-mono text-xs ${directionClass(t.direction)}`}>
                      {directionSign(t.direction)}
                      {tokenLabel(t)}
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
