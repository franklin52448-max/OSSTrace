import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { ChainId } from "@osstrace/core";
import { AlertsRoute } from "./alerts/index.ts";
import { EXPLORERS } from "./explorers.ts";
import { ExplorePage } from "./explorer/index.ts";
import { LabelsRoute } from "./labels/index.ts";
import { TracerRoute } from "./tracer/index.ts";
import TracerView from "./TracerView.tsx";
import { VisualizerRoute } from "./visualizer/index.ts";
import BountiesView from "./BountiesView.tsx";
import PrivateLabelPanel from "./PrivateLabelPanel.tsx";
import RiskPanel from "./RiskPanel.tsx";
import AccountPanel from "./AccountPanel.tsx";
import ThemeCustomizer from "./ThemeCustomizer.tsx";
import { useTheme, useThemeMode } from "./theme.ts";
import { scrollBehavior, useReduceMotion } from "./motion.ts";
import { LabelSubmitForm, ReviewBadge, SubmissionByline, type LabelView } from "./LabelReview.tsx";
import { useSession } from "./session.ts";
import { Notice, SignInPrompt } from "./ui.tsx";
import { ChainIcon, ChainSelect } from "./ChainSelect.tsx";
import HomeFeatures from "./HomeFeatures.tsx";
import SiteFooter from "./SiteFooter.tsx";
import { Wordmark } from "./Wordmark.tsx";
import { amountDisplay, type AmountDisplay, type Direction, type TxStatus } from "./txDisplay.ts";
import { formatTimestamp } from "./timeDisplay.ts";
import { LiveBadge, useLiveTransactions } from "./LiveStream.tsx";
import { CopyButton, SearchBar, Skeleton, Text, cx } from "./prism/components.tsx";
import { IconChevronDown, IconExternalLink } from "./prism/icons.tsx";
import type { AeroShardsProps } from "./vendor/AeroShards.tsx";

// The hero effect is big and only used on the home page, so it loads in its own chunk.
const AeroShards = lazy(() => import("./vendor/AeroShards.tsx"));

const EXPLORER_URL = import.meta.env["VITE_EXPLORER_URL"] ?? "http://localhost:5300";

/** The project's own token (Solana, pump.fun) -- not something this server verifies or tracks any
 *  differently than any other address; shown on the homepage purely so people can find/copy it. */
const OSSTRACE_TOKEN = "6V8ZLegByoWKpRCmfFtpK5mvMbZ5wFTSaajhr5Ckpump";

interface Balance {
  native: { symbol: string; amount: string; decimals: number };
  asOf: string;
}
/** Mirrors core's BalanceResult: a failed balance call is reported, never hides the rest of the report (ADR 0014). */
type BalanceResult = { available: true; balance: Balance } | { available: false; reason: string };
/** Each chain's native unit, for transaction amounts — known without a successful balance call. */
const NATIVE_SYMBOL: Record<ChainId, string> = { ethereum: "ETH", solana: "SOL" };
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
  /** `null` when the chain didn't report when it happened (ADR 0016). */
  timestamp: string | null;
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
  balance: BalanceResult;
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

/* Routing ------------------------------------------------------------------------------------------
   The URL hash is the router (no router library): `#address/<chain>/<address>` is a Lookup report,
   `#graph/<chain>/<address>` opens the Visualizer on that address, and the other views are a bare
   `#<view>`. Every address in the UI links to its own report, so lookups are shareable.
   `#trace` is the Tracer investigation canvas (its own sub-router lives in tracer/TracerRoute.tsx:
   `#trace/doc/<id>` edits a trace, `#trace/view/<id>` is the read-only share link, and
   `#trace/<chain>/<address>` seeds a new trace from an address and jumps into it).
   `#pathfind/<chain>/<address>` is the older multi-hop path-search + Wormhole-bridge-following
   tool (TracerView) -- kept reachable on its own URL now that `#trace` is the canvas; ADR 0022
   notes this gets folded back into the canvas as a feature later, rather than staying a separate
   page for good. */

type View = "lookup" | "graph" | "trace" | "pathfind" | "alerts" | "labels" | "bounties";
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
  if (head === "trace") return { view: "trace", target: null };
  if (head === "pathfind") return { view: "pathfind", target };
  if (head === "alerts" || head === "labels" || head === "bounties") return { view: head, target: null };
  return { view: "lookup", target: null };
}

export const addressHref = (chain: ChainId, address: string): string => `#address/${chain}/${encodeURIComponent(address)}`;
const viewHref = (view: "graph" | "trace" | "pathfind", chain: ChainId, address: string): string => `#${view}/${chain}/${encodeURIComponent(address)}`;

// "Explorer" isn't listed here: its own route (view "lookup") is the bare "#" home page itself --
// a separate tab for it would just be a second link to wherever the wordmark/logo already goes.
const NAV: readonly { id: View; label: string; href: string }[] = [
  { id: "graph", label: "Visualizer", href: "#graph" },
  { id: "trace", label: "Tracer", href: "#trace" },
  { id: "alerts", label: "Alerts", href: "#alerts" },
  { id: "labels", label: "Labels", href: "#labels" },
  { id: "bounties", label: "Bounties", href: "#bounties" },
];

export default function App() {
  const [route, setRoute] = useState<Route>(routeFromHash);
  const headerRef = useRef<HTMLElement>(null);
  const [headerH, setHeaderH] = useState(0);

  useEffect(() => {
    const onHashChange = () => {
      setRoute(routeFromHash());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // The Tracer canvas needs a real pixel height (not "auto"), so it's measured off the sticky
  // header's actual rendered height -- which varies by breakpoint (a second nav row below lg) --
  // rather than a hardcoded or breakpoint-guessed constant.
  useEffect(() => {
    const el = headerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setHeaderH(el.offsetHeight));
    ro.observe(el);
    setHeaderH(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

  const home = route.view === "lookup" && !route.target;
  const targetKey = route.target ? `${route.target.chain}:${route.target.address}` : "empty";

  return (
    <div className="flex min-h-screen flex-col bg-ground text-ink">
      {/* Top bar: wordmark, views, global address search, theme, account. */}
      <header ref={headerRef} className="sticky top-0 z-30 border-b border-line bg-ground/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 w-full max-w-[96rem] items-center gap-4 px-4 sm:px-6">
          <a href="#" className="shrink-0 rounded-md transition-opacity duration-150 hover:opacity-85">
            <Wordmark />
          </a>
          <nav className="hidden items-center gap-0.5 lg:flex" aria-label="Views">
            {NAV.map((tab) => (
              <NavLink key={tab.id} tab={tab} active={route.view === tab.id} />
            ))}
          </nav>
          {/* Home has its own big search; everywhere else the bar carries it. */}
          {!home && (
            <div className="ml-auto hidden w-full max-w-md md:block">
              <GlobalSearch key={targetKey} initial={route.target} small />
            </div>
          )}
          <div className={cx("ml-auto flex shrink-0 items-center gap-1", !home && "md:ml-0")}>
            <ThemeCustomizer />
            <AccountPanel />
          </div>
        </div>
        {/* Narrow screens: views scroll horizontally under the bar. */}
        <nav className="flex gap-0.5 overflow-x-auto px-3 pb-2 lg:hidden" aria-label="Views">
          {NAV.map((tab) => (
            <NavLink key={tab.id} tab={tab} active={route.view === tab.id} />
          ))}
        </nav>
      </header>

      {home ? (
        <Home />
      ) : route.view === "trace" || route.view === "graph" ? (
        // Full-bleed, viewport-height canvas: no page padding/max-width and no page scroll --
        // the Tracer/Visualizer manage their own pan/zoom/scroll inside this box.
        <div className="overflow-hidden" style={{ height: `calc(100dvh - ${headerH}px)` }}>
          {route.view === "trace" ? <TracerRoute /> : <VisualizerRoute />}
        </div>
      ) : (
        <main className="mx-auto w-full max-w-[96rem] flex-1 px-4 py-6 sm:px-6 lg:py-8">
          {route.view === "alerts" ? (
            <AlertsRoute />
          ) : route.view === "labels" ? (
            <LabelsRoute />
          ) : route.view === "bounties" ? (
            <BountiesView />
          ) : route.view === "pathfind" ? (
            <TracerView key={targetKey} initial={route.target} />
          ) : route.target ? (
            <ExplorePage key={`${route.target.chain}:${route.target.address}`} chain={route.target.chain} addr={route.target.address} />
          ) : null}
        </main>
      )}
      {/* The Tracer and Visualizer fill the viewport and scroll internally, so they get no footer. */}
      {route.view !== "trace" && route.view !== "graph" && <SiteFooter />}
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
      <ChainSelect value={chain} onChange={setChain} small={small} />
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

/** reactbits.dev/backgrounds/aero-shards, "graphite" preset: chrome shards in neutral greys. */
const HERO_SHARDS = {
  shardColor: "#a1a1aa",
  accentColor: "#e4e4e7",
  material: "chrome",
  billow: 0.7,
  glow: 0.25,
} satisfies AeroShardsProps;

/** The same field in Nord's Frost blues, for the Nord theme only. Chrome blends each shard 55% toward
 * white, so these are deeper than the Frost swatches themselves to land on them once shaded. */
const HERO_SHARDS_NORD = {
  ...HERO_SHARDS,
  shardColor: "#2f62a8",
  accentColor: "#3fa9c4",
  glow: 0.4,
} satisfies AeroShardsProps;

/** Needs WebGPU; where a visitor's browser can't start it (older browsers, or Brave and others that
 * gate WebGPU behind a flag), nothing renders here and the page's own background shows instead.
 * It lights itself on the GPU, so it reads the theme's dark/light mode rather than CSS tokens. */
function HeroBackground() {
  const [webgpuFailed, setWebgpuFailed] = useState(false);
  const lightMode = useThemeMode() === "light";
  const shards = useTheme().preset === "nord" ? HERO_SHARDS_NORD : HERO_SHARDS;
  // Reduce motion holds the field still (no fly-in either) and stops it reacting to the pointer.
  const still = useReduceMotion();
  if (webgpuFailed) return null;
  return (
    <Suspense fallback={null}>
      <AeroShards {...shards} lightMode={lightMode} paused={still} intro={!still} mouseInteraction={!still} onError={() => setWebgpuFailed(true)} />
    </Suspense>
  );
}

function Home() {
  return (
    <div className="pb-16">
      {/* Full-bleed hero: the shard field, scrims for legibility, then the search on top. */}
      <section className="relative isolate overflow-hidden border-b border-line">
        <div className="absolute inset-0 -z-10">
          <HeroBackground />
        </div>
        <div
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            background:
              "radial-gradient(48% 42% at 50% 46%, color-mix(in srgb, var(--color-ground) 90%, transparent) 0%, color-mix(in srgb, var(--color-ground) 60%, transparent) 55%, transparent 100%), linear-gradient(to bottom, var(--color-ground) 0%, transparent 18%, transparent 70%, var(--color-ground) 100%)",
          }}
          aria-hidden="true"
        />
        {/* Fills the screen under the sticky header (103px tall while the nav wraps below lg, 65px above). */}
        <div className="mx-auto flex min-h-[max(560px,calc(100svh-103px))] max-w-3xl flex-col justify-center px-4 py-20 text-center lg:min-h-[max(560px,calc(100svh-65px))]">
          <Text variant="display" tone="primary" center className="[text-shadow:0_2px_24px_var(--color-ground)] sm:!text-[52px]">
            On-chain intelligence, in the open.
          </Text>
          <Text tone="secondary" center className="mx-auto mt-4 max-w-xl [text-shadow:0_1px_12px_var(--color-ground),0_0_4px_var(--color-ground)]">
            Look up any Ethereum or Solana address — real balances, real transfers, and labels that actually cite where they
            came from. Nothing guessed, nothing dressed up as certain when it isn't. More chains coming soon.
          </Text>
          <div className="mx-auto mt-8 w-full rounded-[20px] border border-line bg-panel/80 p-3 text-left shadow-card backdrop-blur-md">
            <GlobalSearch initial={null} />
          </div>
          <div className="mx-auto mt-4 flex flex-wrap items-center justify-center gap-2 text-xs text-ink-faint">
            <span>$OSSTRACE</span>
            <span className="hash max-w-[220px] truncate text-ink-dim sm:max-w-none">{OSSTRACE_TOKEN}</span>
            <CopyButton value={OSSTRACE_TOKEN} label="Copy" />
            <a
              href={`https://pump.fun/coin/${OSSTRACE_TOKEN}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-ctl px-2 py-1 font-medium text-ink-dim transition-colors duration-150 hover:bg-[var(--helium-elevated-7)] hover:text-ink"
            >
              pump.fun <IconExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
        <button
          type="button"
          onClick={() => document.getElementById("features")?.scrollIntoView({ behavior: scrollBehavior() })}
          className="group absolute inset-x-0 bottom-6 mx-auto flex w-fit flex-col items-center gap-1 text-xs font-medium text-ink-faint transition-colors duration-150 hover:text-ink"
        >
          How it works
          <IconChevronDown className="h-5 w-5 motion-safe:animate-bounce" />
        </button>
      </section>

      <HomeFeatures />
    </div>
  );
}

/** Retired from the live route (ExplorePage replaces it at #address/...), kept for its own test
 *  coverage: real balance/transaction lookup, live updates, sanctions tags, private labels and
 *  community label review/moderation -- none of which has an equivalent in ExplorePage yet. */
export function Lookup({ chain, address }: { chain: ChainId; address: string }) {
  const [state, setState] = useState<LookupState>({ status: "loading" });
  // Two overlapping requests for this same address (the initial load, plus a "quiet" refresh after
  // a label submission) can finish out of order. Only the latest-started one's completion is ever
  // applied; an earlier one finishing late is dropped. Navigating to a *different* address doesn't
  // need this: the `key` on this component in App() remounts it entirely, so a stale response for
  // the old address lands on an unmounted instance and never reaches the new one's state.
  const seq = useRef(0);

  /** `quiet` re-fetches (after a label submission) without blanking the report while it loads. */
  const load = useCallback(
    async (quiet: boolean): Promise<void> => {
      const mySeq = ++seq.current;
      if (!quiet) setState({ status: "loading" });
      try {
        const res = await fetch(`${EXPLORER_URL}/address/${chain}/${encodeURIComponent(address)}`);
        const body = (await res.json()) as AddressReport | { error: string };
        if (seq.current !== mySeq) return;
        if (!res.ok || "error" in body) {
          if (!quiet) setState({ status: "error", message: "error" in body ? body.error : `HTTP ${res.status}` });
          return;
        }
        setState({ status: "done", report: body });
      } catch (cause) {
        if (seq.current !== mySeq) return;
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
      <Notice tone="danger" className="mx-auto max-w-2xl">
        Couldn't look up <span className="hash break-all">{address}</span> on {chain}: {state.message}
      </Notice>
    );
  }
  return <Report report={state.report} onLabelSubmitted={() => void load(true)} />;
}

function ReportSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading address">
      <div className="card overflow-hidden">
        <div className="flex items-center gap-4 p-5">
          <Skeleton width="48px" height="48px" className="!rounded-full" />
          <div className="flex-1 space-y-2.5">
            <Skeleton width="220px" height="22px" />
            <Skeleton width="min(420px, 100%)" height="14px" />
          </div>
        </div>
        <div className="border-t border-line p-5">
          <Skeleton width="min(520px, 100%)" height="40px" />
        </div>
      </div>
      <Skeleton height="420px" className="!rounded-card" />
    </div>
  );
}

function ChainGlyph({ chain }: { chain: ChainId }) {
  return (
    <span
      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[var(--helium-elevated-10)]"
      title={chain === "ethereum" ? "Ethereum" : "Solana"}
    >
      <ChainIcon chain={chain} size={22} />
    </span>
  );
}

/** At most `places` decimals, cut (never rounded up) so the shown balance never overstates; the exact value is in the title. */
function trimDecimals(amount: string, places: number): string {
  const [whole = amount, fraction = ""] = amount.split(".");
  const kept = fraction.slice(0, places).replace(/0+$/, "");
  return kept ? `${whole}.${kept}` : whole;
}

function Report({ report, onLabelSubmitted }: { report: AddressReport; onLabelSubmitted: () => void }) {
  const { chain, value: address } = report.address;
  const session = useSession();
  const sanctioned = report.tags.some((t) => t.tag === "sanctioned");
  // The stream requires a session (ADR 0013 §6); the Explorer checks the token itself.
  const streamToken = session.status === "signed-in" || session.status === "unreachable" ? session.token : null;
  const live = useLiveTransactions<TransactionSummary>(EXPLORER_URL, chain, address, streamToken);
  // "Share as Community label" clicks, tagged with the address they were made on (ADR 0017), so
  // looking up a different address never reopens the form in share mode for it.
  const here = `${chain}:${address}`;
  const [share, setShare] = useState<{ at: string; n: number }>({ at: "", n: 0 });
  const fetched = report.transactions.available ? report.transactions.transactions : [];
  // Pushed transactions the last HTTP fetch didn't already include go on top, marked as new.
  const pushed = live.incoming.filter((t) => !fetched.some((f) => f.hash === t.hash));
  const pushedHashes = new Set(pushed.map((t) => t.hash));
  const shown = [...pushed, ...fetched];
  const explorer = EXPLORERS[chain];
  // The native unit is known from the chain alone (ADR 0014): a failed balance call still lets
  // every transaction amount below show its real symbol.
  const symbol = NATIVE_SYMBOL[chain];

  return (
    <div className="space-y-4">
      {/* Entity header: who this is (only if a sourced label says so), the address, key figures, actions. */}
      <section className="card overflow-hidden" aria-label="Address">
        <div className="flex flex-col gap-4 p-5 lg:flex-row lg:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-4">
            <ChainGlyph chain={chain} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className={cx("text-xl font-semibold tracking-tight sm:text-2xl", report.label ? "text-ink" : "text-ink-dim")}>
                  {report.label?.name ?? "Unlabeled address"}
                </h1>
                {report.label && <span className="chip border-line-strong bg-raised text-ink-dim">{report.label.confidence}</span>}
                {report.label && <ReviewBadge label={report.label} />}
                {sanctioned && <span className="chip border-danger/40 bg-danger/15 text-danger">SANCTIONED</span>}
              </div>
              <div className="mt-1 flex min-w-0 items-center gap-1">
                <span className="hash min-w-0 truncate text-sm text-ink-dim">{address}</span>
                <CopyButton value={address} label="Copy address" className="small shrink-0 !text-ink-faint" />
              </div>
            </div>
          </div>
          <div className="action-buttons shrink-0 flex-wrap">
            <a className="button primary small" href={viewHref("graph", chain, address)}>
              Visualize
            </a>
            <a className="button small" href={viewHref("trace", chain, address)}>
              Trace funds
            </a>
            <a className="button small" href={viewHref("pathfind", chain, address)} title="Multi-hop path search and Wormhole bridge following">
              Find a path
            </a>
            <a className="button small" href={explorer.address + address} target="_blank" rel="noopener noreferrer">
              <IconExternalLink />
              {explorer.name}
            </a>
          </div>
        </div>

        {/* Key figures, as one strip rather than separate cards. */}
        <dl className="grid grid-cols-2 border-t border-line sm:grid-cols-3">
          <Figure
            className="border-r border-line"
            title="Balance"
            footer={report.balance.available ? `as of ${new Date(report.balance.balance.asOf).toLocaleString()}` : "unavailable"}
          >
            {report.balance.available ? (
              <>
                <span title={`${report.balance.balance.native.amount} ${report.balance.balance.native.symbol}`}>
                  {trimDecimals(report.balance.balance.native.amount, 6)}
                </span>{" "}
                <span className="text-sm font-medium text-ink-dim">{report.balance.balance.native.symbol}</span>
              </>
            ) : (
              <span className="text-sm font-medium text-ink-faint" title={report.balance.reason}>
                Unavailable
              </span>
            )}
          </Figure>
          <Figure className="sm:border-r sm:border-line" title="Recent transactions" footer={report.transactions.available ? "most recent first" : "history unavailable"}>
            {report.transactions.available ? shown.length : <span className="text-ink-faint">—</span>}
          </Figure>
          <Figure className="col-span-2 border-t border-line sm:col-span-1 sm:border-t-0" title="Tags" footer={report.tags.length ? "each with a cited source" : "no sourced tags"}>
            {report.tags.length === 0 ? (
              <span className="font-sans text-lg font-medium text-ink-faint">None</span>
            ) : (
              <span className="flex flex-wrap gap-1.5 pt-1">
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
          </Figure>
        </dl>

        {report.label && (
          <div className="border-t border-line px-5 py-3 text-xs text-ink-faint">
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

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {/* Transactions table. */}
        <section className="card overflow-hidden" aria-label="Recent transactions">
          <div className="card-header">
            <h2 className="text-[15px] font-medium text-ink">Transactions</h2>
            <LiveBadge state={live} />
          </div>
          {live.status && !live.status.live && report.transactions.available && (
            <div className="border-b border-line px-4 py-2 text-xs leading-relaxed text-ink-faint">
              Not receiving live updates: {live.status.reason}
            </div>
          )}
          {live.gap && (
            <div className="border-b border-line px-4 py-2 text-xs leading-relaxed text-warn">
              More transactions landed than could be pushed live. Reload for the full recent list.
            </div>
          )}
          {!report.transactions.available ? (
            <div className="px-5 py-10 text-center">
              <div className="text-sm font-medium text-ink-dim">Transaction history unavailable</div>
              <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-ink-faint">{report.transactions.reason}</p>
            </div>
          ) : shown.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-ink-faint">No recent transactions found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-xs font-medium text-ink-faint">
                    <th className="px-4 py-2.5 font-medium">Time</th>
                    <th className="px-3 py-2.5 font-medium">Transaction</th>
                    <th className="px-3 py-2.5 font-medium">From</th>
                    <th className="px-3 py-2.5 font-medium">To</th>
                    <th className="px-4 py-2.5 text-right font-medium">Value</th>
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
                            <span title={formatTimestamp(tx.timestamp)}>{relativeTime(tx.timestamp)}</span>
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
          {session.status === "anonymous" ? (
            <SignInPrompt privateNote>Log in to keep a private note or suggest a public label.</SignInPrompt>
          ) : (
            <>
              <PrivateLabelPanel chain={chain} address={address} onShare={() => setShare((s) => ({ at: here, n: s.n + 1 }))} />
              <LabelSubmitForm chain={chain} address={address} onSubmitted={onLabelSubmitted} shareRequest={share.at === here ? share.n : 0} />
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function Figure({ title, footer, className, children }: { title: string; footer: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cx("min-w-0 px-4 py-3.5 sm:px-5 sm:py-4", className)}>
      <dt className="text-xs font-medium text-ink-faint">{title}</dt>
      <dd className="num mt-1 truncate font-mono text-xl font-semibold tracking-tight text-ink">{children}</dd>
      <dd className="mt-0.5 truncate text-xs text-ink-faint">{footer}</dd>
    </div>
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

/** `null` when the chain didn't report a time (ADR 0016) — shown as "time unknown", in the exact-time title tooltip too. */
function relativeTime(iso: string | null): string {
  if (iso === null) return formatTimestamp(null);
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return formatTimestamp(iso);
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
