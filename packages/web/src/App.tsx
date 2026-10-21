import { useEffect, useState } from "react";
import type { ChainId } from "@opentrace/core";
import GraphView from "./GraphView.tsx";
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

const directionClass = (d: Direction): string => (d === "in" ? "text-emerald-400" : d === "out" ? "text-orange-400" : "text-neutral-400");
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

type View = "lookup" | "graph" | "moderation";

function viewFromHash(): View {
  if (window.location.hash === "#graph") return "graph";
  if (window.location.hash === "#moderation") return "moderation";
  return "lookup";
}

export default function App() {
  const [view, setView] = useState<View>(viewFromHash);
  const session = useSession();

  useEffect(() => {
    const onHashChange = () => setView(viewFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 px-4 py-10">
      <div className={view === "graph" ? "mx-auto max-w-6xl" : "mx-auto max-w-2xl"}>
        <h1 className="text-2xl font-semibold">OpenTraceIntelligence</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Open-source on-chain lookup — real data, sourced labels. No affiliation with any proprietary platform.
        </p>
        <AccountPanel />

        <nav className="mt-5 flex gap-1 border-b border-neutral-800 text-sm" aria-label="Views">
          {(
            [
              { id: "lookup", label: "Lookup", href: "#" },
              { id: "graph", label: "Graph", href: "#graph" },
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
                  ? "-mb-px border-b-2 border-emerald-500 px-3 py-2 font-medium text-neutral-100"
                  : "-mb-px border-b-2 border-transparent px-3 py-2 text-neutral-400 hover:text-neutral-200"
              }
            >
              {tab.label}
            </a>
          ))}
        </nav>

        {view === "graph" ? <GraphView /> : view === "moderation" ? <ModerationView /> : <Lookup />}
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
      <form onSubmit={handleSubmit} className="mt-6 flex gap-2">
        <select
          value={chain}
          onChange={(e) => setChain(e.target.value as ChainId)}
          className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        >
          <option value="ethereum">Ethereum</option>
          <option value="solana">Solana</option>
        </select>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder={chain === "ethereum" ? "0x..." : "a Solana address"}
          className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={state.status === "loading"}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
        >
          {state.status === "loading" ? "Looking up..." : "Look up"}
        </button>
      </form>

      {state.status === "error" && (
        <div className="mt-6 rounded-md border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-300">{state.message}</div>
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
    <div className="mt-6 space-y-4">
      <PrivateLabelPanel chain={chain} address={address} />

      {report.label && (
        <div className="rounded-md border border-neutral-800 bg-neutral-900 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{report.label.name}</span>
            <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">{report.label.confidence}</span>
            <ReviewBadge label={report.label} />
            {sanctioned && <span className="rounded bg-red-900 px-2 py-0.5 text-xs font-medium text-red-200">SANCTIONED</span>}
          </div>
          <a href={report.label.source.url} target="_blank" rel="noreferrer" className="mt-1 block text-xs text-neutral-500 hover:text-neutral-300">
            Source: {report.label.source.description} · added {report.label.source.addedAt}
          </a>
          <SubmissionByline label={report.label} />
        </div>
      )}

      <LabelSubmitForm chain={report.address.chain} address={report.address.value} onSubmitted={onLabelSubmitted} />

      <div className="rounded-md border border-neutral-800 bg-neutral-900 px-4 py-3">
        <div className="text-xs uppercase tracking-wide text-neutral-500">Balance</div>
        <div className="mt-1 text-xl font-semibold">
          {report.balance.native.amount} {report.balance.native.symbol}
        </div>
        <div className="text-xs text-neutral-500">as of {new Date(report.balance.asOf).toLocaleString()}</div>
      </div>

      <div className="rounded-md border border-neutral-800 bg-neutral-900 px-4 py-3">
        <div className="text-xs uppercase tracking-wide text-neutral-500">Recent transactions</div>
        {!report.transactions.available ? (
          <div className="mt-2 text-sm text-neutral-400">Unavailable — {report.transactions.reason}</div>
        ) : report.transactions.transactions.length === 0 ? (
          <div className="mt-2 text-sm text-neutral-400">No recent transactions found.</div>
        ) : (
          <ul className="mt-2 divide-y divide-neutral-800 text-sm">
            {report.transactions.transactions.map((tx) => (
              <li key={tx.hash} className="flex items-center justify-between py-2">
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs text-neutral-400">{tx.hash}</div>
                  <div className="text-xs text-neutral-500">{new Date(tx.timestamp).toLocaleString()}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className={directionClass(tx.direction)}>
                    {directionSign(tx.direction)}
                    {tx.valueNative} {report.balance.native.symbol}
                  </div>
                  {tx.tokenTransfers?.map((t, i) => (
                    <div key={i} className={`text-xs ${directionClass(t.direction)}`}>
                      {directionSign(t.direction)}
                      {tokenLabel(t)}
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
