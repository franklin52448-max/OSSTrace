import { useEffect, useState } from "react";
import type { ChainId } from "@osstrace/core";
import { Notice } from "./ui.tsx";

const RISK_URL = import.meta.env["VITE_RISK_SCORING_URL"] ?? "http://localhost:5305";

// --- The risk scoring API's response shape (see packages/features/risk-scoring/README.md) ------
interface Source {
  description: string;
  url: string;
  addedAt: string;
}
interface Tag {
  tag: string;
  source: Source;
}
interface PathEdge {
  id: string;
  hash: string;
  source: string;
  target: string;
}
type Tier = "severe" | "high" | "medium" | "low" | "none" | "inconclusive";
interface SearchGap {
  id: string;
  hops: number;
  reason: "breadth-cap" | "budget-exhausted" | "unavailable" | "history-truncated";
  detail?: string;
}
interface RiskAssessment {
  score: number | null;
  tier: Tier;
  basis: "direct" | "hop-distance" | "none";
  directTags: Tag[];
  nearest: { id: string; hops: number; riskTags: Tag[]; label: { name: string } | null; path: PathEdge[] } | null;
  flagged: { id: string; hops: number }[];
  search: {
    maxHops: number;
    txLimitPerNode: number;
    adapterCallsUsed: number;
    nodesChecked: number;
    complete: boolean;
    gaps: SearchGap[];
  } | null;
  searchIncomplete: boolean;
  scoreIsLowerBound: boolean;
  explanation: string;
}

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; result: RiskAssessment };

const MAX_GAPS_SHOWN = 8;

const shortId = (id: string): string => (id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id);

/** Existing semantic tokens only: danger for direct/1-hop, warn for 2-3 hops and for an unfinished search. */
const TIER_CHIP: Record<Tier, string> = {
  severe: "border-danger/40 bg-danger/15 text-danger",
  high: "border-danger/40 bg-danger/15 text-danger",
  medium: "border-warn/40 bg-warn/15 text-warn",
  low: "border-warn/40 bg-warn/15 text-warn",
  none: "border-line-strong bg-raised text-ink-dim",
  inconclusive: "border-warn/40 bg-warn/15 text-warn",
};

const GAP_WORDS: Record<SearchGap["reason"], string> = {
  "breadth-cap": "not expanded (breadth cap)",
  "budget-exhausted": "not expanded (call budget ran out)",
  unavailable: "couldn't be fetched",
  "history-truncated": "more history than was fetched",
};

/**
 * Risk score for the looked-up address. Computed on request, not on every lookup: when the address
 * isn't directly tagged, scoring runs a real Tracer search (up to ~40 RPC calls).
 */
export default function RiskPanel({ chain, address }: { chain: ChainId; address: string }) {
  const [state, setState] = useState<State>({ status: "idle" });

  // A new lookup must never keep showing the previous address's score.
  useEffect(() => setState({ status: "idle" }), [chain, address]);

  async function compute(): Promise<void> {
    setState({ status: "loading" });
    try {
      const res = await fetch(`${RISK_URL}/risk/${chain}/${encodeURIComponent(address)}`);
      const body = (await res.json()) as RiskAssessment | { error: string };
      if (!res.ok || "error" in body) {
        setState({ status: "error", message: "error" in body ? body.error : `HTTP ${res.status}` });
        return;
      }
      setState({ status: "done", result: body });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setState({ status: "error", message: `Risk scoring API unreachable at ${RISK_URL} (start it with npm run dev:risk) — ${message}` });
    }
  }

  return (
    <section className="card p-4" aria-label="Risk score">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-medium text-ink">Risk score</h2>
        <button type="button" onClick={() => void compute()} disabled={state.status === "loading"} className="btn-outline">
          {state.status === "loading" ? "Scoring…" : state.status === "done" ? "Recompute" : "Compute"}
        </button>
      </div>

      {state.status === "idle" && (
        <p className="mt-1.5 text-xs leading-relaxed text-ink-faint">
          Based only on sourced tags (today: ingested sanctions lists) on this address or the nearest flagged one within a few hops.
        </p>
      )}

      {state.status === "error" && (
        <Notice tone="danger" className="mt-3 text-xs">
          {state.message}
        </Notice>
      )}

      {state.status === "done" && <RiskResult result={state.result} />}
    </section>
  );
}

function RiskResult({ result }: { result: RiskAssessment }) {
  const evidenceTags = result.basis === "direct" ? result.directTags : (result.nearest?.riskTags ?? []);
  return (
    <div className="mt-3 space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        <span className="num font-mono text-2xl font-semibold tracking-tight text-ink">
          {result.score === null ? "—" : result.score}
          {result.score !== null && <span className="text-base font-medium text-ink-dim"> / 100</span>}
          {result.scoreIsLowerBound && result.score !== null && <span className="text-base font-medium text-warn"> (minimum)</span>}
        </span>
        <span className={`chip ${TIER_CHIP[result.tier]}`}>{result.tier.toUpperCase()}</span>
        {result.searchIncomplete && <span className="chip border-warn/40 bg-warn/15 text-warn">SEARCH INCOMPLETE</span>}
      </div>

      <p className="text-sm text-ink-dim">{result.explanation}</p>

      {result.nearest && (
        <div>
          <div className="section-title">
            Nearest flagged address · {result.nearest.hops} hop{result.nearest.hops === 1 ? "" : "s"}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="hash break-all text-xs text-ink">{result.nearest.id}</span>
            {result.nearest.label && <span className="text-xs text-ink-dim">{result.nearest.label.name}</span>}
          </div>
          <ol className="mt-1.5 space-y-0.5">
            {result.nearest.path.map((edge) => (
              <li key={edge.id} className="hash text-xs text-ink-faint">
                {shortId(edge.source)} → {shortId(edge.target)} · tx {shortId(edge.hash)}
              </li>
            ))}
          </ol>
        </div>
      )}

      {evidenceTags.length > 0 && (
        <ul className="space-y-0.5">
          {evidenceTags.map((t, i) => (
            <li key={i}>
              <a
                href={t.source.url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-ink-faint underline decoration-line-strong underline-offset-2 transition-colors duration-150 hover:text-ink-dim"
              >
                {t.tag}: {t.source.description} · added {t.source.addedAt}
              </a>
            </li>
          ))}
        </ul>
      )}

      {result.search && (
        <div className="text-xs text-ink-faint">
          Searched up to {result.search.maxHops} hop{result.search.maxHops === 1 ? "" : "s"}, {result.search.txLimitPerNode} most recent
          transactions per address · <span className="num">{result.search.nodesChecked}</span> addresses checked ·{" "}
          <span className="num">{result.search.adapterCallsUsed}</span> chain calls
          {result.search.gaps.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {result.search.gaps.slice(0, MAX_GAPS_SHOWN).map((g) => (
                <li key={`${g.id}-${g.reason}`} className="hash text-warn">
                  {shortId(g.id)} (hop {g.hops}) — {GAP_WORDS[g.reason]}
                  {g.detail ? `: ${g.detail}` : ""}
                </li>
              ))}
              {result.search.gaps.length > MAX_GAPS_SHOWN && (
                <li className="text-warn">
                  …and <span className="num">{result.search.gaps.length - MAX_GAPS_SHOWN}</span> more (full list in the API response)
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
