import { useCallback, useEffect, useState } from "react";
import type { ChainId } from "@osstrace/core";
import GraphView from "./GraphView.tsx";
import TracerView from "./TracerView.tsx";
import BountiesView from "./BountiesView.tsx";
import CasesView from "./CasesView.tsx";
import PrivateLabelPanel from "./PrivateLabelPanel.tsx";
import RiskPanel from "./RiskPanel.tsx";
import AccountPanel from "./AccountPanel.tsx";
import ModerationView from "./ModerationView.tsx";
import { LabelSubmitForm, ReviewBadge, SubmissionByline, type LabelView } from "./LabelReview.tsx";
import { isModerator, useSession } from "./session.ts";
import { amountDisplay, type AmountDisplay, type Direction, type TxStatus } from "./txDisplay.ts";
import { LiveBadge, useLiveTransactions } from "./LiveStream.tsx";
import { CopyButton, Dropdown, SearchBar, Skeleton, Text, cx } from "./prism/components.tsx";
import { IconArrowRight, IconExternalLink } from "./prism/icons.tsx";
import Ferrofluid, { type FerrofluidProps } from "./vendor/Ferrofluid.tsx";

const EXPLORER_URL = import.meta.env["VITE_EXPLORER_URL"] ?? "http://localhost:5300";

interface Balance {
  native: { symbol: string; amount: string; decimals: number };
  asOf: string;
}
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
  /** `"failed"` = reverted on-chain: the amounts are what it attempted, nothing moved. */
  status?: TxStatus;
}

const TONE_CLASS: Record<AmountDisplay["tone"], string> = {
  inbound: "text-inbound",
  outbound: "text-outbound",
  neutral: "text-ink-faint",
};
/** A reverted transaction's amounts are struck through: shown for reference, never as moved. */
const amountClass = (d: AmountDisplay): string => `${TONE_CLASS[d.tone]}${d.failed ? " line-through" : ""}`;
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
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; report: AddressReport };

const CHAINS: readonly { value: ChainId; label: string }[] = [
  { value: "ethereum", label: "Ethereum" },
  { value: "solana", label: "Solana" },
];
const isChain = (value: string): value is ChainId => CHAINS.some((c) => c.value === value);

const EXPLORERS: Record<ChainId, { name: string; tx: string; address: string }> = {
  ethereum: { name: "Etherscan", tx: "https://etherscan.io/tx/", address: "https://etherscan.io/address/" },
  solana: { name: "Solscan", tx: "https://solscan.io/tx/", address: "https://solscan.io/account/" },
};

/* Routing ------------------------------------------------------------------------------------------
   The URL hash is the router (no router library): `#address/<chain>/<address>` is a Lookup report,
   `#graph/<chain>/<address>` opens the Visualizer on that address, and the other views are a bare
   `#<view>`. Every address in the UI links to its own report, so lookups are shareable. */

type View = "lookup" | "graph" | "trace" | "cases" | "bounties" | "moderation";
interface Route {
  view: View;
  target: { chain: ChainId; address: string } | null;
}

function routeFromHash(): Route {
  const [head = "", chain = "", ...rest] = window.location.hash.replace(/^#/, "").split("/");
  const address = decodeURIComponent(rest.join("/"));
  const target = isChain(chain) && address ? { chain, address } : null;
  if (head === "address") return { view: "lookup", target };
  if (head === "graph") return { view: "graph", target };
  if (head === "trace" || head === "cases" || head === "bounties" || head === "moderation") return { view: head, target: null };
  return { view: "lookup", target: null };
}

export const addressHref = (chain: ChainId, address: string): string => `#address/${chain}/${encodeURIComponent(address)}`;

const NAV: readonly { id: View; label: string; href: string }[] = [
  { id: "lookup", label: "Explorer", href: "#" },
  { id: "graph", label: "Visualizer", href: "#graph" },
  { id: "trace", label: "Tracer", href: "#trace" },
  { id: "cases", label: "Cases", href: "#cases" },
  { id: "bounties", label: "Bounties", href: "#bounties" },
  { id: "moderation", label: "Moderation", href: "#moderation" },
];

/** Original mark: three linked nodes — the queried address and two counterparties. */
function Wordmark() {
  return (
    <span className="flex items-center gap-2">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" className="shrink-0">
        <path d="M7.4 10.6 16 6.4M7.4 13.4 16 17.6" stroke="var(--color-signal)" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
        <circle cx="5.5" cy="12" r="3" fill="var(--color-signal)" />
        <circle cx="18" cy="5.5" r="2.2" fill="none" stroke="var(--color-ink-dim)" strokeWidth="1.5" />
        <circle cx="18" cy="18.5" r="2.2" fill="none" stroke="var(--color-ink-dim)" strokeWidth="1.5" />
      </svg>
      <span className="text-[16px] font-semibold tracking-tight text-ink">OSSTrace</span>
    </span>
  );
}

export default function App() {
  const [route, setRoute] = useState<Route>(routeFromHash);
  const session = useSession();

  useEffect(() => {
    const onHashChange = () => {
      setRoute(routeFromHash());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const nav = NAV.filter((tab) => tab.id !== "moderation" || isModerator(session) || route.view === "moderation");

  return (
    <div className="min-h-screen bg-ground text-ink">
      {/* Top bar: wordmark, views, global address search, account. */}
      <header className="sticky top-0 z-30 border-b border-line bg-ground/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 w-full max-w-[96rem] items-center gap-4 px-4 sm:px-6">
          <a href="#" className="shrink-0 rounded-md transition-opacity duration-150 hover:opacity-85">
            <Wordmark />
          </a>
          <nav className="hidden items-center gap-0.5 lg:flex" aria-label="Views">
            {nav.map((tab) => (
              <NavLink key={tab.id} tab={tab} active={route.view === tab.id} />
            ))}
          </nav>
          <div className="ml-auto hidden w-full max-w-md md:block">
            <GlobalSearch key={route.target ? `${route.target.chain}:${route.target.address}` : "empty"} initial={route.target} small />
          </div>
          <div className="ml-auto shrink-0 md:ml-0">
            <AccountPanel />
          </div>
        </div>
        {/* Narrow screens: views scroll horizontally under the bar. */}
        <nav className="flex gap-0.5 overflow-x-auto px-3 pb-2 lg:hidden" aria-label="Views">
          {nav.map((tab) => (
            <NavLink key={tab.id} tab={tab} active={route.view === tab.id} />
          ))}
        </nav>
      </header>

      {route.view === "lookup" && !route.target ? (
        <Home />
      ) : (
        <main className="mx-auto w-full max-w-[96rem] px-4 py-6 sm:px-6 lg:py-8">
          {route.view === "graph" ? (
            <GraphView key={route.target ? `${route.target.chain}:${route.target.address}` : "empty"} initial={route.target} />
          ) : route.view === "trace" ? (
            <TracerView />
          ) : route.view === "cases" ? (
            <CasesView />
          ) : route.view === "bounties" ? (
            <BountiesView />
          ) : route.view === "moderation" ? (
            <ModerationView />
          ) : route.target ? (
            <Lookup key={`${route.target.chain}:${route.target.address}`} chain={route.target.chain} address={route.target.address} />
          ) : null}
        </main>
      )}
    </div>
  );
}

function NavLink({ tab, active }: { tab: (typeof NAV)[number]; active: boolean }) {
  return (
    <a
      href={tab.href}
      aria-current={active ? "page" : undefined}
      className={cx(
        "button transparent small shrink-0",
        active ? "!bg-[var(--helium-elevated-10)] text-ink" : "!text-ink-dim hover:!text-ink",
      )}
    >
      {tab.label}
    </a>
  );
}

/** Chain + address search. Submitting navigates to the address's report. */
function GlobalSearch({ initial, small }: { initial: Route["target"]; small?: boolean }) {
  const [chain, setChain] = useState<ChainId>(initial?.chain ?? "ethereum");
  const [address, setAddress] = useState(initial?.address ?? "");

  function handleSubmit(event: React.FormEvent): void {
    event.preventDefault();
    const trimmed = address.trim();
    if (!trimmed) return;
    // Guess the chain from the address shape so pasting "just works"; the dropdown still overrides.
    const target: ChainId = /^0x[0-9a-fA-F]{40}$/.test(trimmed) ? "ethereum" : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed) ? "solana" : chain;
    setChain(target);
    window.location.hash = addressHref(target, trimmed);
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full items-center gap-2">
      <Dropdown
        aria-label="Chain"
        value={chain}
        onValueChange={(v) => isChain(v) && setChain(v)}
        options={CHAINS}
        className={cx("shrink-0", small && "[--dropdown-height:36px] text-sm")}
      />
      <SearchBar
        aria-label="Search an address"
        small={small}
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder={chain === "ethereum" ? "Search address (0x…)" : "Search Solana address"}
        className="hash"
        spellCheck={false}
      />
    </form>
  );
}

/** Settings from reactbits.dev/backgrounds/ferrofluid?preset=peaks&sharpness=4&fluidity=0.85&spikeHeight=0.45, in neutral chrome. */
const HERO_FLUID = {
  colors: ["#ffffff", "#d4d4d8", "#52525b"],
  brightness: 1,
  scale: 1.6,
  tilt: 48,
  turbulence: 1,
  speed: 0.5,
  magnetism: 1,
  sharpness: 4,
  fluidity: 0.85,
  spikeHeight: 0.45,
} satisfies FerrofluidProps;

function Home() {
  return (
    <div className="pb-16">
      {/* Full-bleed hero: the ferrofluid field, scrims for legibility, then the search on top. */}
      <section className="relative isolate overflow-hidden border-b border-line">
        <div className="absolute inset-0 -z-10">
          <Ferrofluid {...HERO_FLUID} />
        </div>
        <div
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            background:
              "radial-gradient(60% 55% at 50% 38%, rgb(0 0 0 / 0.82) 0%, rgb(0 0 0 / 0.35) 60%, transparent 100%), linear-gradient(to bottom, var(--color-ground) 0%, transparent 18%, transparent 70%, var(--color-ground) 100%)",
          }}
          aria-hidden="true"
        />
        <div className="mx-auto flex min-h-[min(78vh,720px)] max-w-3xl flex-col justify-center px-4 py-20 text-center">
          <Text variant="display" tone="primary" center className="sm:!text-[52px]">
            On-chain intelligence, in the open.
          </Text>
          <Text tone="secondary" center className="mx-auto mt-4 max-w-xl">
            Look up any Ethereum or Solana address: real balances, recent transactions, and only labels with a cited public
            source.
          </Text>
          <div className="mx-auto mt-8 w-full rounded-[20px] border border-line bg-panel/80 p-3 text-left shadow-card backdrop-blur-md">
            <GlobalSearch initial={null} />
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-3xl px-4">
        <div className="mt-8 grid gap-3 sm:grid-cols-3">
          {[
            { href: "#graph", title: "Visualizer", desc: "See an address and its direct counterparties as a graph." },
            { href: "#trace", title: "Tracer", desc: "Follow funds up to three hops, including Wormhole bridges." },
            { href: "#bounties", title: "Bounties", desc: "Request a feature, or build one someone asked for." },
          ].map((item) => (
            <a key={item.href} href={item.href} className="button card !items-start border border-line">
              <span className="link-text">
                <span className="text-[15px] font-medium text-ink">{item.title}</span>
                <span className="text-[13px] leading-snug text-ink-dim">{item.desc}</span>
              </span>
              <IconArrowRight className="mt-0.5 text-ink-faint" />
            </a>
          ))}
        </div>
        <p className="mt-10 text-center text-xs text-ink-faint">
          Open source (AGPL-3.0). No affiliation with any proprietary platform.
        </p>
      </div>
    </div>
  );
}

function Lookup({ chain, address }: { chain: ChainId; address: string }) {
  const [state, setState] = useState<LookupState>({ status: "loading" });

  /** `quiet` re-fetches (after a label submission) without blanking the report while it loads. */
  const load = useCallback(
    async (quiet: boolean): Promise<void> => {
      if (!quiet) setState({ status: "loading" });
      try {
        const res = await fetch(`${EXPLORER_URL}/address/${chain}/${encodeURIComponent(address)}`);
        const body = (await res.json()) as AddressReport | { error: string };
        if (!res.ok || "error" in body) {
          if (!quiet) setState({ status: "error", message: "error" in body ? body.error : `HTTP ${res.status}` });
          return;
        }
        setState({ status: "done", report: body });
      } catch (cause) {
        // A failed quiet refresh keeps showing the report we have; the next lookup will retry.
        if (!quiet) setState({ status: "error", message: cause instanceof Error ? cause.message : String(cause) });
      }
    },
    [chain, address],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  if (state.status === "loading") return <ReportSkeleton />;
  if (state.status === "error") {
    return (
      <div role="alert" className="mx-auto max-w-2xl rounded-card border border-danger/35 bg-danger/10 px-4 py-3 text-sm text-danger">
        Couldn't look up <span className="hash break-all">{address}</span> on {chain}: {state.message}
      </div>
    );
  }
  return <Report report={state.report} onLabelSubmitted={() => void load(true)} />;
}

function ReportSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading address">
      <div className="card flex items-center gap-4 p-5">
        <Skeleton width="56px" height="56px" className="!rounded-full" />
        <div className="flex-1 space-y-2.5">
          <Skeleton width="220px" height="22px" />
          <Skeleton width="min(420px, 100%)" height="14px" />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height="92px" className="!rounded-card" />
        ))}
      </div>
      <Skeleton height="420px" className="!rounded-card" />
    </div>
  );
}

function ChainGlyph({ chain }: { chain: ChainId }) {
  return (
    <span
      className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[var(--helium-elevated-10)] text-2xl text-signal"
      aria-hidden="true"
    >
      {chain === "ethereum" ? "Ξ" : "◎"}
    </span>
  );
}

function Report({ report, onLabelSubmitted }: { report: AddressReport; onLabelSubmitted: () => void }) {
  const { chain, value: address } = report.address;
  const sanctioned = report.tags.some((t) => t.tag === "sanctioned");
  const live = useLiveTransactions<TransactionSummary>(EXPLORER_URL, chain, address);
  const fetched = report.transactions.available ? report.transactions.transactions : [];
  // Pushed transactions the last HTTP fetch didn't already include go on top, marked as new.
  const pushed = live.incoming.filter((t) => !fetched.some((f) => f.hash === t.hash));
  const pushedHashes = new Set(pushed.map((t) => t.hash));
  const shown = [...pushed, ...fetched];
  const explorer = EXPLORERS[chain];
  const symbol = report.balance.native.symbol;

  return (
    <div className="space-y-4">
      {/* Entity header: who this is (only if a sourced label says so), the address, and actions. */}
      <section className="card p-5" aria-label="Address">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-4">
            <ChainGlyph chain={chain} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className={cx("text-2xl font-semibold tracking-tight", report.label ? "text-ink" : "text-ink-dim")}>
                  {report.label?.name ?? "Unlabeled address"}
                </h1>
                <span className="chip border-line-strong bg-raised capitalize text-ink-dim">{chain}</span>
                {report.label && <span className="chip border-line-strong bg-raised text-ink-dim">{report.label.confidence}</span>}
                {report.label && <ReviewBadge label={report.label} />}
                {sanctioned && <span className="chip border-danger/40 bg-danger/15 text-danger">SANCTIONED</span>}
              </div>
              <div className="mt-1.5 flex min-w-0 items-center gap-1">
                <span className="hash min-w-0 truncate text-sm text-ink-dim">{address}</span>
                <CopyButton value={address} label="Copy address" className="small shrink-0 !text-ink-faint" />
              </div>
            </div>
          </div>
          <div className="action-buttons shrink-0 flex-wrap">
            <a className="button primary" href={`#graph/${chain}/${encodeURIComponent(address)}`}>
              Visualize
            </a>
            <a className="button" href="#trace">
              Trace funds
            </a>
            <a className="button" href={explorer.address + address} target="_blank" rel="noopener noreferrer">
              <IconExternalLink />
              {explorer.name}
            </a>
          </div>
        </div>
        {report.label && (
          <div className="mt-4 border-t border-line pt-3 text-xs text-ink-faint">
            <a
              href={report.label.source.url}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-line-strong underline-offset-2 transition-colors duration-150 hover:text-ink-dim"
            >
              Source: {report.label.source.description} · added {report.label.source.addedAt}
            </a>
            <SubmissionByline label={report.label} />
          </div>
        )}
      </section>

      {/* Key figures. */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat title="Balance" footer={`as of ${new Date(report.balance.asOf).toLocaleString()}`}>
          {report.balance.native.amount} <span className="text-base font-medium text-ink-dim">{symbol}</span>
        </Stat>
        <Stat title="Recent transactions" footer={report.transactions.available ? "most recent first" : "history unavailable"}>
          {report.transactions.available ? shown.length : "—"}
        </Stat>
        <Stat title="Tags" footer={report.tags.length ? "each with a cited source" : "no sourced tags"}>
          {report.tags.length === 0 ? (
            <span className="font-sans text-xl font-medium text-ink-faint">None</span>
          ) : (
            <span className="flex flex-wrap gap-1.5 pt-1.5">
              {report.tags.map((t) => (
                <a
                  key={t.tag}
                  href={t.source.url}
                  target="_blank"
                  rel="noreferrer"
                  title={`${t.source.description} · added ${t.source.addedAt}`}
                  className={cx(
                    "chip text-xs",
                    t.tag === "sanctioned" ? "border-danger/40 bg-danger/15 text-danger" : "border-line-strong bg-raised text-ink-dim",
                  )}
                >
                  {t.tag}
                </a>
              ))}
            </span>
          )}
        </Stat>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        {/* Transactions table. */}
        <section className="card overflow-hidden" aria-label="Recent transactions">
          <div className="card-header">
            <h2 className="section-title">Transactions</h2>
            <LiveBadge state={live} />
          </div>
          {live.status && !live.status.live && report.transactions.available && (
            <div className="border-b border-line px-4 py-2 text-xs leading-relaxed text-ink-faint">
              Not receiving live updates: {live.status.reason}
            </div>
          )}
          {live.gap && (
            <div className="border-b border-line px-4 py-2 text-xs leading-relaxed text-warn">
              More transactions landed between two indexer refreshes than could be pushed. Reload the page for the full recent
              list.
            </div>
          )}
          {!report.transactions.available ? (
            <div className="px-4 py-6 text-sm text-ink-dim">Unavailable — {report.transactions.reason}</div>
          ) : shown.length === 0 ? (
            <div className="px-4 py-6 text-sm text-ink-dim">No recent transactions found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                    <th className="px-4 py-2.5 font-semibold">Time</th>
                    <th className="px-3 py-2.5 font-semibold">Transaction</th>
                    <th className="px-3 py-2.5 font-semibold">From</th>
                    <th className="px-3 py-2.5 font-semibold">To</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {shown.map((tx) => {
                    const native = amountDisplay(tx.direction, tx.status);
                    return (
                      <tr key={tx.hash} className="align-top transition-colors duration-150 hover:bg-raised/50">
                        <td className="whitespace-nowrap px-4 py-3 text-xs text-ink-dim">
                          <div className="flex items-center gap-1.5">
                            {pushedHashes.has(tx.hash) && <span className="chip border-signal/30 bg-signal/10 text-signal">NEW</span>}
                            <span title={new Date(tx.timestamp).toLocaleString()}>{relativeTime(tx.timestamp)}</span>
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <a
                            href={explorer.tx + tx.hash}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hash text-xs text-ink-dim transition-colors duration-150 hover:text-signal"
                          >
                            {shortId(tx.hash)}
                          </a>
                          {native.failed && (
                            <div
                              className="chip mt-1 !flex w-fit border-danger/40 bg-danger/10 text-danger"
                              title="This transaction reverted on-chain: the amounts shown are what it attempted — nothing actually moved"
                            >
                              FAILED · nothing moved
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <AddressCell chain={chain} value={tx.from} self={address} />
                        </td>
                        <td className="px-3 py-3">
                          {tx.to ? <AddressCell chain={chain} value={tx.to} self={address} /> : <span className="text-xs text-ink-faint">contract creation</span>}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className={cx("num whitespace-nowrap font-mono text-sm font-medium", amountClass(native))}>
                            {native.sign}
                            {tx.valueNative} <span className="text-xs font-normal text-ink-faint">{symbol}</span>
                          </div>
                          {tx.tokenTransfers?.map((t, i) => {
                            const token = amountDisplay(t.direction, tx.status);
                            return (
                              <div key={i} className={cx("num mt-0.5 whitespace-nowrap font-mono text-xs", amountClass(token))}>
                                {token.sign}
                                {tokenLabel(t)}
                              </div>
                            );
                          })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Side column: analysis + your own notes. */}
        <aside className="space-y-4">
          <RiskPanel chain={chain} address={address} />
          <PrivateLabelPanel chain={chain} address={address} />
          <LabelSubmitForm chain={chain} address={address} onSubmitted={onLabelSubmitted} />
        </aside>
      </div>
    </div>
  );
}

function Stat({ title, footer, children }: { title: string; footer: string; children: React.ReactNode }) {
  return (
    <section className="card p-4" aria-label={title}>
      <div className="section-title">{title}</div>
      <div className="num mt-1.5 truncate font-mono text-2xl font-semibold tracking-tight text-ink">{children}</div>
      <div className="mt-1 truncate text-xs text-ink-faint">{footer}</div>
    </section>
  );
}

/** A counterparty in the table: links to its own report; the queried address reads "This address". */
function AddressCell({ chain, value, self }: { chain: ChainId; value: string; self: string }) {
  if (value.toLowerCase() === self.toLowerCase()) {
    return <span className="chip border-line-strong bg-raised text-ink-dim">This address</span>;
  }
  return (
    <a href={addressHref(chain, value)} title={value} className="hash text-xs text-signal transition-colors duration-150 hover:text-ink">
      {shortId(value)}
    </a>
  );
}

function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return iso;
  if (seconds < 60) return "just now";
  const units: [number, string][] = [
    [60 * 60 * 24 * 365, "y"],
    [60 * 60 * 24 * 30, "mo"],
    [60 * 60 * 24, "d"],
    [60 * 60, "h"],
    [60, "m"],
  ];
  for (const [size, unit] of units) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${unit} ago`;
  }
  return "just now";
}

