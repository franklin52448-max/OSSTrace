import { useState } from "react";
import type { ChainId } from "@opentrace/core";

const EXPLORER_URL = import.meta.env["VITE_EXPLORER_URL"] ?? "http://localhost:5300";

interface Balance {
  native: { symbol: string; amount: string; decimals: number };
  asOf: string;
}
interface TransactionSummary {
  hash: string;
  timestamp: string;
  from: string;
  to: string | null;
  valueNative: string;
  direction: "in" | "out" | "self";
}
type TransactionsResult = { available: true; transactions: TransactionSummary[] } | { available: false; reason: string };
interface Label {
  name: string;
  confidence: "verified" | "predicted";
  source: { description: string; url: string; addedAt: string };
}
interface Tag {
  tag: string;
  source: { description: string; url: string; addedAt: string };
}
interface AddressReport {
  balance: Balance;
  transactions: TransactionsResult;
  label: Label | null;
  tags: Tag[];
}

type LookupState = { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "done"; report: AddressReport };

export default function App() {
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
      setState({ status: "done", report: body });
    } catch (cause) {
      setState({ status: "error", message: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-semibold">OpenTraceIntelligence</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Open-source on-chain lookup — real data, sourced labels. No affiliation with any proprietary platform.
        </p>

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

        {state.status === "done" && <Report report={state.report} />}
      </div>
    </div>
  );
}

function Report({ report }: { report: AddressReport }) {
  const sanctioned = report.tags.some((t) => t.tag === "sanctioned");
  return (
    <div className="mt-6 space-y-4">
      {report.label && (
        <div className="rounded-md border border-neutral-800 bg-neutral-900 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="font-medium">{report.label.name}</span>
            <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">{report.label.confidence}</span>
            {sanctioned && <span className="rounded bg-red-900 px-2 py-0.5 text-xs font-medium text-red-200">SANCTIONED</span>}
          </div>
          <a href={report.label.source.url} target="_blank" rel="noreferrer" className="mt-1 block text-xs text-neutral-500 hover:text-neutral-300">
            Source: {report.label.source.description} · added {report.label.source.addedAt}
          </a>
        </div>
      )}

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
                  <div className={tx.direction === "in" ? "text-emerald-400" : tx.direction === "out" ? "text-orange-400" : "text-neutral-400"}>
                    {tx.direction === "in" ? "+" : tx.direction === "out" ? "-" : ""}
                    {tx.valueNative}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
