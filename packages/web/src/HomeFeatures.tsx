// The home page's feature tour, under the hero. Each row is one feature: what it answers, the real
// limits it works within, and a small diagram drawn in the same colours the live views use
// (inbound green, outbound orange, entities yellow). Diagrams are illustrative: the
// addresses and amounts in them are placeholders, never real data.
import type { ReactNode } from "react";
import { Bell, Search, Tag, Waypoints } from "lucide-react";
import { cx } from "./prism/components.tsx";
import { IconArrowRight, IconCheck, IconExternalLink, IconX } from "./prism/icons.tsx";
import { ChainIcon } from "./ChainSelect.tsx";
import type { ChainId as ChainKey } from "@osstrace/core";
import { scrollBehavior } from "./motion.ts";
import { openLogin } from "./ui.tsx";

const C = {
  ink: "var(--color-ink)",
  dim: "var(--color-ink-dim)",
  faint: "var(--color-ink-faint)",
  line: "var(--color-line-strong)",
  panel: "var(--color-panel)",
  raised: "var(--color-raised)",
  signal: "var(--color-signal)",
  inbound: "var(--color-inbound)",
  outbound: "var(--color-outbound)",
  warn: "var(--color-warn)",
  danger: "var(--color-danger)",
};

/** Puts the cursor in the hero search, which sits at the top of the same page. */
function focusHeroSearch(): void {
  window.scrollTo({ top: 0, behavior: scrollBehavior() });
  document.querySelector<HTMLInputElement>("main input[type=search], section input[type=search]")?.focus({ preventScroll: true });
}

export default function HomeFeatures() {
  return (
    <section id="features" className="mx-auto max-w-6xl scroll-mt-[103px] px-4 pt-20 sm:px-6 lg:scroll-mt-[65px]" aria-labelledby="features-title">
      <div className="mx-auto max-w-2xl text-center">
        <h2 id="features-title" className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          Every number shows where it came from
        </h2>
        <p className="mt-4 text-[15px] leading-relaxed text-ink-dim">
          Balances and transfers come straight from the chain, priced with real market data at the hour they happened. When
          history is only partly loaded or a data provider fails, the page says so instead of filling the gap.
        </p>
      </div>

      <div className="mt-16 space-y-20 sm:space-y-28">
        <FeatureRow
          name="Explorer"
          title="Look up any address"
          lead="Paste an Ethereum or Solana address to see what it holds in USD, who it deals with most and every transfer it made, on one page."
          points={[
            "Ethereum data comes from Blockscout and Solana from public RPC, with no API key needed. Nothing is estimated.",
            "Holdings are priced with DefiLlama. Tokens without a price, often airdropped spam, are left out of the total but still counted.",
            "Partial history or a provider error is flagged right on the page, along with how far back the data reaches.",
          ]}
          action={
            <button type="button" onClick={focusHeroSearch} className="btn-accent">
              Search an address
            </button>
          }
          diagram={<ExplorerDiagram />}
        />
        <FeatureRow
          name="Visualizer"
          title="See who an address deals with"
          lead="Draws addresses and their counterparties as a live graph you can grow, filter and save."
          points={[
            "Start from one or more addresses. Add any counterparty to the base and its own counterparties join the graph.",
            "Filter by direction, minimum USD value, time window, token and chain. Your entities collapse into a single node.",
            "A scratch graph lives in the URL. Save it to your account, and share a read-only link if you want to.",
          ]}
          action={<FeatureLink href="#graph">Open the Visualizer</FeatureLink>}
          diagram={<VisualizerDiagram />}
          flip
        />
        <FeatureRow
          name="Tracer"
          title="Follow the money on a canvas"
          lead="Build an investigation step by step: start from an address, pull in where its funds went, and lay the flow out your way."
          points={[
            "Every edge is made of real transfers, combined into one line with a count and USD total when there are many.",
            "Keep notes, colour nodes and undo any step. The overview adds up volume, transfers, tokens and chains.",
            "Traces save to your account. Share a read-only link with anyone, no sign-in needed to view it.",
          ]}
          action={<FeatureLink href="#trace">Open the Tracer</FeatureLink>}
          diagram={<TracerDiagram />}
        />
        <FeatureRow
          name="Alerts"
          title="Know when an address moves"
          lead="Set a rule on the addresses you care about and hear about new transfers as they land."
          points={[
            "Match on direction, a minimum USD value and specific tokens, across up to 20 addresses or entities per rule.",
            "Matches arrive in your inbox on OSSTrace, and can be sent to your own webhook as well.",
            "Only new activity counts: a rule watches from the moment you create it and never replays old history.",
          ]}
          action={<FeatureLink href="#alerts">Open Alerts</FeatureLink>}
          diagram={<AlertsDiagram />}
          flip
        />
        <FeatureRow
          name="Labels"
          title="Your own label set"
          lead="Name addresses, group them into entities and tag them. Your labels follow you everywhere: address pages, graphs, traces and alerts."
          points={[
            "Labels are private to your account. Nobody else can see them.",
            "An entity groups many addresses under one name, like an exchange's wallets, and acts as one node in a graph.",
            "Bring an existing list in from CSV or JSON, and export the whole set whenever you like.",
          ]}
          action={<FeatureLink href="#labels">Open Labels</FeatureLink>}
          diagram={<LabelsDiagram />}
        />
      </div>

      <BuildWithBounties />

      <StartCta />
    </section>
  );
}

function FeatureRow({
  name,
  title,
  lead,
  points,
  action,
  diagram,
  flip,
}: {
  name: string;
  title: string;
  lead: string;
  points: string[];
  action?: ReactNode;
  diagram: ReactNode;
  flip?: boolean;
}) {
  return (
    <article className="grid items-center gap-8 lg:grid-cols-2 lg:gap-14">
      <div className={cx(flip && "lg:order-2")}>
        <h3 className="text-2xl font-semibold tracking-tight text-ink sm:text-[28px]">{title}</h3>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-dim">{lead}</p>
        <ul className="mt-6 space-y-3">
          {points.map((point) => (
            <li key={point} className="flex gap-3 text-sm leading-relaxed text-ink-dim">
              <span className="mt-[0.55rem] h-1 w-1 shrink-0 rounded-full bg-ink-faint" aria-hidden="true" />
              {point}
            </li>
          ))}
        </ul>
        {action && <div className="mt-7">{action}</div>}
      </div>
      <figure className={cx("card graph-field overflow-hidden p-4 sm:p-6", flip && "lg:order-1")} aria-label={`${name} diagram`}>
        {diagram}
      </figure>
    </article>
  );
}

function FeatureLink({ href, onClick, children }: { href: string; onClick?: () => void; children: ReactNode }) {
  return (
    <a
      href={href}
      onClick={
        onClick &&
        ((e) => {
          e.preventDefault();
          onClick();
        })
      }
      className="group inline-flex items-center gap-1.5 text-sm font-medium text-ink transition-colors duration-150 hover:text-signal"
    >
      {children}
      <IconArrowRight className="h-4 w-4 transition-transform duration-150 group-hover:translate-x-0.5" />
    </a>
  );
}

/* Building on OSSTrace -------------------------------------------------------------------------- */

const REPO_URL = "https://github.com/OpenTraceIntelligence/OSSTrace/blob/main/";

const BOUNTY_STEPS: readonly { title: string; who: string; body: string }[] = [
  {
    title: "Write the spec",
    who: "Anyone",
    body: "Describe the feature in depth and name the reward you're offering. You don't need to write code to open a bounty.",
  },
  {
    title: "Back it",
    who: "Anyone, optional",
    body: "Send ETH, SOL or an ERC-20 or SPL token to the project's wallet and record the transaction. The server checks it on-chain before it shows.",
  },
  {
    title: "Build it",
    who: "Any developer",
    body: "Submit a pull request against the bounty. Chains and features are self-contained packages, so you rarely touch the rest of the code.",
  },
  {
    title: "Get picked",
    who: "The bounty's opener",
    body: "The opener reviews the pull requests, picks a winner and pays the reward to the builder directly. There's no moderator in between.",
  },
];

const BUILD_TARGETS: readonly { title: string; path: string; body: string; doc: string; aside?: ReactNode }[] = [
  {
    title: "Add a chain",
    path: "packages/chains/<chain>",
    body: "Implement one adapter, balance and recent transactions, against a real data source. Every page picks the chain up from there.",
    doc: "packages/chains/README.md",
    aside: <WantedChains />,
  },
  {
    title: "Add a feature",
    path: "packages/features/<feature>",
    body: "A package with its own API, built on the shared chain data and accounts. It never reaches into another feature's code.",
    doc: "packages/features/README.md",
  },
  {
    title: "Add label data",
    path: "data/labels",
    body: "Public datasets that make lookups smarter. Every entry cites a checkable source, or it isn't merged.",
    doc: "data/labels/README.md",
    aside: <WantedLabels />,
  },
];

/**
 * Bounties as the way OSSTrace grows: the four-step flow, what can be built, and exactly what the
 * board does and doesn't do with money (ADR 0009, ADR 0020).
 */
function BuildWithBounties() {
  return (
    <section className="mt-28 sm:mt-36" aria-labelledby="bounties-title">
      <div className="mx-auto max-w-2xl text-center">
        <h2 id="bounties-title" className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          Build OSSTrace with us
        </h2>
        <p className="mt-4 text-[15px] leading-relaxed text-ink-dim">
          OSSTrace is open source and made of plug-in packages: each chain and each feature lives in its own folder.
          Bounties are how the community decides what gets built next, and how the people who build it get paid.
        </p>
      </div>

      {/* The flow, as one strip: numbered steps joined by a line on wide screens, stacked on narrow ones. */}
      <ol className="card mt-12 grid gap-px overflow-hidden bg-line p-0 sm:grid-cols-2 lg:grid-cols-4" aria-label="How a bounty works">
        {BOUNTY_STEPS.map((step, i) => (
          <li key={step.title} className="relative bg-panel p-5 sm:p-6">
            <div className="flex items-center gap-3">
              <span className="num flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--helium-elevated-10)] text-xs font-semibold text-ink">
                {i + 1}
              </span>
              {i < BOUNTY_STEPS.length - 1 && <span className="hidden h-px flex-1 bg-line-strong lg:block" aria-hidden="true" />}
            </div>
            <h3 className="mt-4 text-base font-semibold tracking-tight text-ink">{step.title}</h3>
            <div className="mt-0.5 text-xs font-medium text-signal">{step.who}</div>
            <p className="mt-2 text-sm leading-relaxed text-ink-dim">{step.body}</p>
          </li>
        ))}
      </ol>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="card p-5 sm:p-6">
          <h3 className="text-lg font-semibold tracking-tight text-ink">What you can build</h3>
          <p className="mt-1 text-sm text-ink-dim">Each of these is one folder, with a README that lists the exact steps.</p>
          <ul className="mt-5 space-y-3">
            {BUILD_TARGETS.map((target) => (
              <li key={target.title}>
                <a
                  href={REPO_URL + target.doc}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group block rounded-[12px] border border-line p-4 transition-colors duration-150 hover:border-line-strong hover:bg-[var(--helium-elevated-5)]"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="text-sm font-semibold text-ink">{target.title}</span>
                    {target.aside ?? <span className="hash text-xs text-ink-faint">{target.path}</span>}
                  </div>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink-dim">{target.body}</p>
                </a>
              </li>
            ))}
          </ul>
        </div>

        <div className="card flex flex-col p-5 sm:p-6">
          <h3 className="text-lg font-semibold tracking-tight text-ink">Where the money goes</h3>
          <p className="mt-1 text-sm text-ink-dim">The board keeps the record. It never holds the reward.</p>
          <ul className="mt-5 space-y-3 text-sm leading-relaxed">
            <MoneyPoint ok>Bounties, pull requests and the winner are all public, no login needed to read them.</MoneyPoint>
            <MoneyPoint ok>Deposits are checked against the chain itself, never taken on the sender's word.</MoneyPoint>
            <MoneyPoint>OSSTrace never escrows or pays out. The reward moves from the opener to the winner, off-platform.</MoneyPoint>
            <MoneyPoint>Pull requests aren't checked automatically. The bounty's own opener reviews each one before picking.</MoneyPoint>
          </ul>
          <div className="mt-auto flex flex-wrap gap-2 pt-6">
            <a href="#bounties" className="btn-accent">
              Browse bounties
            </a>
            <a href={REPO_URL + "CONTRIBUTING.md"} target="_blank" rel="noopener noreferrer" className="btn-outline">
              Contributing guide
              <IconExternalLink className="h-4 w-4" />
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * A brand mark on its own disc: one or more filled paths in a 24x24 box, or an image for a mark too
 * detailed for inline paths. `scale` sizes it within the disc.
 */
type BrandMark = {
  name: string;
  disc: string;
  scale: number;
  paths?: readonly { d: string; fill: string; evenOdd?: boolean }[];
  image?: string;
};

/**
 * Chains nobody has built an adapter for yet, as a tight row of their marks in brand colours.
 * Marks: Bitcoin and Robinhood from Simple Icons (CC0-1.0); Tron and Monad from Web3 Icons (MIT, see
 * vendor/README.md).
 */
const WANTED_CHAINS: readonly BrandMark[] = [
  { name: "Bitcoin", disc: "#ffffff", scale: 1, paths: [{ fill: "#F7931A", d: "M23.638 14.904c-1.602 6.43-8.113 10.34-14.542 8.736C2.67 22.05-1.244 15.525.362 9.105 1.962 2.67 8.475-1.243 14.9.358c6.43 1.605 10.342 8.115 8.738 14.548v-.002zm-6.35-4.613c.24-1.59-.974-2.45-2.64-3.03l.54-2.153-1.315-.33-.525 2.107c-.345-.087-.705-.167-1.064-.25l.526-2.127-1.32-.33-.54 2.165c-.285-.067-.565-.132-.84-.2l-1.815-.45-.35 1.407s.975.225.955.236c.535.136.63.486.615.766l-1.477 5.92c-.075.166-.24.406-.614.314.015.02-.96-.24-.96-.24l-.66 1.51 1.71.426.93.242-.54 2.19 1.32.327.54-2.17c.36.1.705.19 1.05.273l-.51 2.154 1.32.33.545-2.19c2.24.427 3.93.257 4.64-1.774.57-1.637-.03-2.58-1.217-3.196.854-.193 1.5-.76 1.68-1.93h.01zm-3.01 4.22c-.404 1.64-3.157.75-4.05.53l.72-2.9c.896.23 3.757.67 3.33 2.37zm.41-4.24c-.37 1.49-2.662.735-3.405.55l.654-2.64c.744.18 3.137.524 2.75 2.084v.006z" }] },
  { name: "Tron", disc: "#FF060A", scale: 0.66, paths: [{ fill: "#ffffff", evenOdd: true, d: "M4.42 3.186a.57.57 0 0 1 .552-.17L16.876 5.93a.5.5 0 0 1 .197.092l2.422 1.767a.565.565 0 0 1 .133.773l-8.332 12.191a.563.563 0 0 1-.998-.13L4.306 3.753a.57.57 0 0 1 .114-.566M6.383 6.23l4.16 11.712.684-6.069zm5.958 5.838-.695 6.175 5.884-8.61zm5.72-3.93-3.793 1.78 2.542-2.691zm-2.396-1.343L6.41 4.531l5.426 6.318z" }] },
  { name: "Monad", disc: "#836EF9", scale: 0.68, paths: [{ fill: "#ffffff", d: "M12 3c-2.599 0-9 6.4-9 9s6.401 9 9 9 9-6.401 9-9-6.401-9-9-9m-1.402 14.146c-1.097-.298-4.043-5.453-3.744-6.549s5.453-4.042 6.549-3.743c1.095.298 4.042 5.453 3.743 6.549-.298 1.095-5.453 4.042-6.549 3.743" }] },
  { name: "Robinhood Chain", disc: "#CCFF00", scale: 0.6, paths: [{ fill: "#000000", d: "M2.84 24h.53c.096 0 .192-.048.224-.128C7.591 13.696 11.94 8.656 14.67 5.638c.112-.128.064-.225-.096-.225h-4.88a.55.55 0 0 0-.45.225L5.746 9.972c-.514.642-.642 1.236-.642 2.086v4.43c-1.14 3.194-1.862 5.361-2.392 7.32-.032.125.016.192.129.192M20.447.646c-.754-.802-4.157-.834-5.73-.224a3 3 0 0 0-.786.465 41 41 0 0 0-3.323 3.178c-.112.113-.064.225.097.225h5.409c.497 0 .786.289.786.786v6.1c0 .16.128.208.225.064l3.258-4.254c.53-.69.69-.898.835-1.861.192-1.413.08-3.58-.77-4.479m-6.982 16.18 2.231-3.676a.7.7 0 0 0 .064-.29V6.73c0-.16-.112-.225-.224-.097-3.355 3.74-5.971 7.672-8.395 12.407-.06.12.016.225.16.177l5.009-1.54c.565-.174.882-.402 1.155-.852" }] },
];

/**
 * Kinds of label data nobody has contributed yet: an exchange, a government, an asset manager and a
 * launchpad. Binance from Simple Icons (CC0-1.0); the US coat of arms from the Great Seal (public
 * domain, public/us-coat-of-arms.png); BlackRock and pump.fun drawn here (see vendor/README.md).
 */
const WANTED_LABELS: readonly BrandMark[] = [
  { name: "Binance", disc: "#F0B90B", scale: 0.62, paths: [{ fill: "#181A20", d: "M16.624 13.9202l2.7175 2.7154-7.353 7.353-7.353-7.352 2.7175-2.7164 4.6355 4.6595 4.6356-4.6595zm4.6366-4.6366L24 12l-2.7154 2.7164L18.5682 12l2.6924-2.7164zm-9.272.001l2.7163 2.6914-2.7164 2.7174v-.001L9.2721 12l2.7164-2.7154zm-9.2722-.001L5.4088 12l-2.6914 2.6924L0 12l2.7164-2.7164zM11.9885.0115l7.353 7.329-2.7174 2.7154-4.6356-4.6356-4.6355 4.6595-2.7174-2.7154 7.353-7.353z" }] },
  { name: "US Government", disc: "#ffffff", scale: 1, image: "/us-coat-of-arms.png" },
  { name: "BlackRock", disc: "#000000", scale: 0.72, paths: [{ fill: "#ffffff", evenOdd: true, d: "M7.5 4.5H13C15.6 4.5 17 5.8 17 7.9C17 9.3 16.3 10.3 15.1 10.7C16.7 11.1 17.6 12.3 17.6 14C17.6 18.2 16 19.5 13.3 19.5H7.5ZM10.2 6.8V10H12.7C13.8 10 14.4 9.4 14.4 8.4C14.4 7.4 13.8 6.8 12.7 6.8ZM10.2 12.2V17.2H13C14.2 17.2 14.9 16.3 14.9 14.7C14.9 13.1 14.2 12.2 13 12.2Z" }] },
  {
    name: "pump.fun",
    disc: "#ffffff",
    scale: 0.8,
    paths: [
      { fill: "#1B4D3E", d: "M3.94 12.42L12.42 3.94A5.4 5.4 0 0 1 20.06 11.58L11.58 20.06A5.4 5.4 0 0 1 3.94 12.42Z" },
      { fill: "#ffffff", d: "M9.88 8.75L13.56 5.07A3.8 3.8 0 0 1 18.93 10.44L15.25 14.12Z" },
      { fill: "#53C68C", d: "M5.07 13.56L8.75 9.88L14.12 15.25L10.44 18.93A3.8 3.8 0 0 1 5.07 13.56Z" },
    ],
  },
];

function WantedChains() {
  return <BrandMarks marks={WANTED_CHAINS} label="Chains not supported yet" />;
}

function WantedLabels() {
  return <BrandMarks marks={WANTED_LABELS} label="Label data not added yet" />;
}

function BrandMarks({ marks, label }: { marks: readonly BrandMark[]; label: string }) {
  return (
    <ul className="flex shrink-0 -space-x-1" aria-label={label}>
      {marks.map((mark) => (
        <li
          key={mark.name}
          title={mark.name}
          className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full ring-2 ring-[var(--color-panel)]"
          style={{ background: mark.disc }}
        >
          {mark.image ? (
            <img src={mark.image} alt="" className="h-full w-full" style={{ transform: `scale(${mark.scale})` }} />
          ) : (
            <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden="true">
              <g transform={`translate(12 12) scale(${mark.scale}) translate(-12 -12)`}>
                {mark.paths?.map((path) => (
                  <path key={path.d} fill={path.fill} fillRule={path.evenOdd ? "evenodd" : undefined} d={path.d} />
                ))}
              </g>
            </svg>
          )}
          <span className="sr-only">{mark.name}</span>
        </li>
      ))}
    </ul>
  );
}

function MoneyPoint({ ok, children }: { ok?: boolean; children: ReactNode }) {
  return (
    <li className="flex gap-3 text-ink-dim">
      {ok ? <IconCheck className="mt-0.5 h-4 w-4 shrink-0 text-inbound" /> : <IconX className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />}
      <span>
        <span className="sr-only">{ok ? "Does: " : "Doesn't: "}</span>
        {children}
      </span>
    </li>
  );
}

/* Closing call to action -------------------------------------------------------------------------- */

const ACCOUNT_PERKS: readonly { icon: ReactNode; title: string; body: string }[] = [
  {
    icon: <Waypoints className="h-4 w-4" />,
    title: "Saved traces",
    body: "Keep every investigation canvas, pick it up later, and share a read-only link.",
  },
  {
    icon: <Bell className="h-4 w-4" />,
    title: "Alerts",
    body: "Watch addresses and get an inbox entry or a webhook when funds move.",
  },
  {
    icon: <Tag className="h-4 w-4" />,
    title: "Private labels",
    body: "Name addresses and group them into entities. Only you can see them.",
  },
  {
    icon: <Search className="h-4 w-4" />,
    title: "Live lookups",
    body: "Real balances, priced holdings and transfers for any address, on demand.",
  },
];

/** The page's last word: start with a lookup (no account), or sign in to keep your work. */
function StartCta() {
  return (
    <section className="card mt-28 overflow-hidden sm:mt-36" aria-labelledby="start-title">
      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="flex flex-col justify-center p-6 sm:p-10">
          <h2 id="start-title" className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
            Start your own investigation
          </h2>
          <p className="mt-4 max-w-md text-[15px] leading-relaxed text-ink-dim">
            Looking an address up needs no account. Sign in when you want to keep your work: your traces, alerts and labels,
            all in one place.
          </p>
          <div className="mt-8 flex flex-wrap gap-2">
            <button type="button" onClick={openLogin} className="btn-accent">
              Connect a wallet
              <IconArrowRight className="h-4 w-4" />
            </button>
            <button type="button" onClick={focusHeroSearch} className="btn-outline">
              Search an address
            </button>
          </div>
          <p className="mt-4 text-xs text-ink-faint">Your labels and traces stay private to your account.</p>
        </div>

        <div className="graph-field border-t border-line p-6 sm:p-10 lg:border-l lg:border-t-0">
          <div className="text-xs font-medium text-ink-faint">With an account</div>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {ACCOUNT_PERKS.map((perk) => (
              <li key={perk.title} className="rounded-[14px] border border-line bg-panel p-4">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--helium-elevated-10)] text-ink" aria-hidden="true">
                  {perk.icon}
                </span>
                <h3 className="mt-3 text-sm font-semibold text-ink">{perk.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-ink-dim">{perk.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/* Diagrams ------------------------------------------------------------------------------------- */

/** Theme-aware fills for diagram nodes: the queried address, and everything else. */
const FOCUS_FILL = "color-mix(in srgb, var(--color-signal) 18%, var(--color-panel))";

/** A miniature address page: identity and priced total, holdings, top counterparties, provenance. */
function ExplorerDiagram() {
  return (
    <div className="space-y-3" aria-hidden="true">
      <div className="rounded-[14px] border border-line bg-panel">
        <div className="flex items-center gap-3 p-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--helium-elevated-10)]">
            <ChainIcon chain="ethereum" size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-semibold text-ink">Treasury wallet</span>
              <span className="hash text-xs text-ink-faint">(0x8f3a…c21a)</span>
            </div>
            <div className="num mt-0.5 font-mono text-lg font-semibold text-ink">$4,218,902</div>
          </div>
          <span className="chip shrink-0 self-start border-warn/35 bg-warn/10 text-warn">Partial history</span>
        </div>
        <div className="grid border-t border-line text-xs sm:grid-cols-2">
          <div className="border-line sm:border-r">
            <div className="px-4 pb-1 pt-3 font-medium text-ink-faint">Holdings</div>
            {[
              ["USDC", "2,400,000", "$2.40M"],
              ["ETH", "512.4", "$1.22M"],
              ["WBTC", "9.1", "$598K"],
            ].map(([sym, amt, usd]) => (
              <div key={sym} className="flex items-center justify-between gap-2 px-4 py-1.5">
                <span className="font-mono font-medium text-ink">{sym}</span>
                <span className="num font-mono text-ink-faint">{amt}</span>
                <span className="num font-mono text-ink">{usd}</span>
              </div>
            ))}
            <div className="px-4 pb-3 pt-1 text-[11px] text-ink-faint">+ 14 tokens without a price, not counted</div>
          </div>
          <div className="border-t border-line sm:border-t-0">
            <div className="px-4 pb-1 pt-3 font-medium text-ink-faint">Top counterparties · 30d</div>
            {[
              ["Example Exchange", 0.92, C.inbound],
              ["0x41c2…9e0b", 0.58, C.outbound],
              ["0x77d0…13fa", 0.31, C.outbound],
            ].map(([who, w, color]) => (
              <div key={String(who)} className="px-4 py-1.5">
                <div className={cx("truncate", String(who).startsWith("0x") ? "hash text-ink-dim" : "font-medium text-ink")}>{who}</div>
                <div className="mt-1 h-1 rounded-full bg-[var(--helium-elevated-7)]">
                  <div className="h-1 rounded-full" style={{ width: `${Number(w) * 100}%`, background: String(color) }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 pl-4 text-xs text-ink-faint">
        <svg width="18" height="18" viewBox="0 0 18 18" className="shrink-0">
          <path d="M3 0v9a4 4 0 0 0 4 4h8" fill="none" stroke={C.line} strokeWidth="1.5" />
          <path d="m12 10 3 3-3 3" fill="none" stroke={C.line} strokeWidth="1.5" />
        </svg>
        <span>Source: Blockscout · prices: DefiLlama · history covered from 12 Mar 2026</span>
      </div>
    </div>
  );
}

/** Two base addresses, their counterparties, and an entity collapsed into one node. */
function VisualizerDiagram() {
  const bases = [
    { x: 170, y: 140 },
    { x: 318, y: 156 },
  ];
  const others = [
    { x: 70, y: 70, r: 8, base: 0, dir: "in" },
    { x: 58, y: 196, r: 10, base: 0, dir: "out" },
    { x: 150, y: 250, r: 7, base: 0, dir: "out" },
    { x: 244, y: 56, r: 9, base: 0, dir: "in" },
    { x: 420, y: 80, r: 9, base: 1, dir: "out" },
    { x: 428, y: 226, r: 8, base: 1, dir: "in" },
    { x: 300, y: 262, r: 7, base: 1, dir: "out" },
  ] as const;
  const entity = { x: 244, y: 56 };
  return (
    <svg viewBox="0 0 480 300" className="block h-auto w-full" role="img" aria-label="Two base addresses with their counterparties, sharing one entity">
      <Arrowheads />
      {/* The two bases deal with each other. */}
      {(() => {
        const [x1, y1, x2, y2] = trim(bases[0]!.x, bases[0]!.y, bases[1]!.x, bases[1]!.y, 20, 22);
        return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={C.outbound} strokeWidth="3.2" opacity="0.85" markerEnd="url(#hf-arrow-out)" />;
      })()}
      {/* Both bases deal with the same entity. */}
      {(() => {
        const [x1, y1, x2, y2] = trim(bases[1]!.x, bases[1]!.y, entity.x, entity.y, 20, 22);
        return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={C.inbound} strokeWidth="1.4" opacity="0.85" markerEnd="url(#hf-arrow-in)" />;
      })()}
      {others.map((n, i) => {
        const base = bases[n.base]!;
        const inbound = n.dir === "in";
        const isEntity = n.x === entity.x && n.y === entity.y;
        const [a, b] = inbound ? [n, base] : [base, n];
        const [x1, y1, x2, y2] = trim(a.x, a.y, b.x, b.y, inbound ? (isEntity ? 22 : n.r + 3) : 20, inbound ? 22 : isEntity ? 24 : n.r + 5);
        return (
          <line
            key={i}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={inbound ? C.inbound : C.outbound}
            strokeWidth={1.2 + (i % 3) * 0.7}
            opacity="0.8"
            markerEnd={`url(#hf-arrow-${n.dir})`}
          />
        );
      })}
      {others.map((n, i) =>
        n.x === entity.x && n.y === entity.y ? null : <circle key={i} cx={n.x} cy={n.y} r={n.r} fill={C.raised} stroke={C.line} strokeWidth="2" />,
      )}
      {/* Entity: several addresses drawn as one node. */}
      <g>
        <circle cx={entity.x} cy={entity.y} r="20" fill={C.raised} stroke={C.warn} strokeWidth="2" />
        <circle cx={entity.x - 6} cy={entity.y - 4} r="4" fill={C.warn} opacity="0.8" />
        <circle cx={entity.x + 6} cy={entity.y - 4} r="4" fill={C.warn} opacity="0.8" />
        <circle cx={entity.x} cy={entity.y + 6} r="4" fill={C.warn} opacity="0.8" />
        <text x={entity.x + 28} y={entity.y + 4} fontSize="11" fill={C.warn}>
          Example Exchange · 3 addresses
        </text>
      </g>
      {bases.map((n, i) => (
        <g key={i}>
          <circle cx={n.x} cy={n.y} r="22" fill="none" stroke={C.ink} strokeWidth="1.2" strokeDasharray="3 3" opacity="0.6" />
          <circle cx={n.x} cy={n.y} r="16" fill={FOCUS_FILL} stroke={C.signal} strokeWidth="3" />
        </g>
      ))}
      <text x={bases[0]!.x - 34} y={bases[0]!.y + 40} fontSize="11" fill={C.dim}>
        base
      </text>
      <text x={bases[1]!.x + 14} y={bases[1]!.y + 40} fontSize="11" fill={C.dim}>
        base
      </text>
      <g transform="translate(340 6)">
        <rect width="140" height="24" rx="12" fill={C.panel} stroke={C.line} />
        <text x="70" y="16" fontSize="10.5" fill={C.dim} textAnchor="middle">
          USD ≥ $1,000 · last 30d
        </text>
      </g>
      <Legend
        y={292}
        items={[
          ["in", C.inbound],
          ["out", C.outbound],
          ["entity", C.warn],
        ]}
      />
    </svg>
  );
}

/** A trace canvas: address cards joined by summed transfer edges, with a note pinned beside them. */
function TracerDiagram() {
  const cards = [
    { x: 0, y: 112, name: "Exploit contract", sub: "0x8f3a…c21a", usd: "$0", focus: true },
    { x: 180, y: 34, name: "0x41c2…9e0b", sub: "Ethereum", usd: "$1.9M" },
    { x: 180, y: 190, name: "0x77d0…13fa", sub: "Ethereum", usd: "$310K" },
    { x: 360, y: 112, name: "Example Exchange", sub: "deposit", usd: "$84M" },
  ];
  const W = 120;
  const H = 46;
  const edges: { from: number; to: number; count: string; usd: string }[] = [
    { from: 0, to: 1, count: "4 transfers", usd: "$2.1M" },
    { from: 0, to: 2, count: "1 transfer", usd: "$320K" },
    { from: 1, to: 3, count: "6 transfers", usd: "$1.8M" },
  ];
  const mid = (i: number) => ({ x: cards[i]!.x + W / 2, y: cards[i]!.y + H / 2 });
  return (
    <svg viewBox="0 0 480 300" className="block h-auto w-full" role="img" aria-label="A trace canvas with four address cards joined by summed transfer edges">
      <Arrowheads />
      {edges.map((e, i) => {
        const a = cards[e.from]!;
        const b = cards[e.to]!;
        const x1 = a.x + W;
        const y1 = a.y + H / 2;
        const x2 = b.x - 4;
        const y2 = b.y + H / 2;
        const cx = (x1 + x2) / 2;
        return (
          <g key={i}>
            <path d={`M${x1} ${y1} C${cx} ${y1} ${cx} ${y2} ${x2} ${y2}`} fill="none" stroke={C.outbound} strokeWidth="1.8" markerEnd="url(#hf-arrow-out)" />
            <g transform={`translate(${cx} ${(y1 + y2) / 2})`}>
              <rect x="-27" y="-15" width="54" height="30" rx="9" fill={C.panel} stroke={C.line} />
              <text y="-3" fontSize="8.5" fill={C.faint} textAnchor="middle">
                {e.count}
              </text>
              <text y="9" fontSize="9.5" fontWeight="600" fill={C.dim} textAnchor="middle" fontFamily="var(--font-mono)">
                {e.usd}
              </text>
            </g>
          </g>
        );
      })}
      {cards.map((c, i) => (
        <g key={i} transform={`translate(${c.x} ${c.y})`}>
          <rect width={W} height={H} rx="12" fill={c.focus ? FOCUS_FILL : C.panel} stroke={c.focus ? C.signal : C.line} strokeWidth={c.focus ? 2 : 1.2} />
          <text x="12" y="19" fontSize="11" fontWeight="600" fill={C.ink} fontFamily={c.name.startsWith("0x") ? "var(--font-mono)" : undefined}>
            {c.name}
          </text>
          <text x="12" y="35" fontSize="10" fill={C.faint}>
            {c.sub}
          </text>
          <text x={W - 10} y="35" fontSize="10" fill={C.dim} textAnchor="end" fontFamily="var(--font-mono)">
            {c.usd}
          </text>
        </g>
      ))}
      {/* A note pinned to the canvas. */}
      <g transform="translate(330 224)">
        <rect width="148" height="54" rx="12" fill={C.panel} stroke={C.warn} strokeOpacity="0.5" strokeDasharray="4 3" />
        <text x="12" y="20" fontSize="10" fill={C.warn}>
          Note
        </text>
        <text x="12" y="38" fontSize="10.5" fill={C.dim}>
          Cashed out within 2 hours
        </text>
      </g>
      {(() => {
        const m = mid(3);
        return <line x1={m.x} y1={224} x2={m.x} y2={cards[3]!.y + H + 2} stroke={C.warn} strokeOpacity="0.5" strokeDasharray="3 3" />;
      })()}
    </svg>
  );
}

/** One alert rule and the matches it produced, delivered to the inbox and a webhook. */
function AlertsDiagram() {
  return (
    <div className="space-y-3" aria-hidden="true">
      <div className="rounded-[14px] border border-line bg-panel p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-ink">Treasury outflows</span>
          <span className="chip border-inbound/35 bg-inbound/10 text-inbound">on</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
          {["Outgoing", "≥ $10,000", "USDC, ETH", "3 addresses"].map((v) => (
            <span key={v} className="rounded-full bg-[var(--helium-elevated-7)] px-2.5 py-1 font-medium text-ink-dim">
              {v}
            </span>
          ))}
        </div>
      </div>
      <div className="rounded-[14px] border border-line bg-panel">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5 text-xs">
          <span className="font-medium text-ink-faint">Inbox</span>
          <span className="flex items-center gap-1.5 text-ink-faint">
            <span className="h-1.5 w-1.5 rounded-full bg-inbound" />
            also sent to your webhook
          </span>
        </div>
        <div className="divide-y divide-line">
          {[
            ["2m ago", "0x8f3a…c21a", "−250,000 USDC", "$250,000"],
            ["3h ago", "0x41c2…9e0b", "−18.5 ETH", "$44,050"],
          ].map(([t, addr, amt, usd]) => (
            <div key={t} className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs">
              <span className="w-12 shrink-0 text-ink-faint">{t}</span>
              <span className="hash min-w-0 flex-1 truncate text-ink-dim">{addr}</span>
              <span className="num font-mono font-medium text-outbound">{amt}</span>
              <span className="num hidden w-16 text-right font-mono text-ink sm:block">{usd}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="pl-4 text-xs text-ink-faint">Watching since the rule was created, checked about every minute.</div>
    </div>
  );
}

/** An entity with its labelled addresses and tags, all private to the account. */
function LabelsDiagram() {
  const addresses: [string, string, ChainKey][] = [
    ["Hot wallet 1", "0x5a1f…e3b0", "ethereum"],
    ["Hot wallet 2", "0x9c4d…07a2", "ethereum"],
    ["Solana deposits", "8hQd…kP2w", "solana"],
  ];
  return (
    <div className="space-y-3" aria-hidden="true">
      <div className="rounded-[14px] border border-line bg-panel">
        <div className="flex items-center gap-3 border-b border-line p-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-full border border-line-strong text-sm font-semibold text-ink-dim">E</span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-ink">Example Exchange</div>
            <div className="text-xs text-ink-faint">Entity · exchange · 3 addresses</div>
          </div>
          <span className="chip shrink-0 border-private/45 bg-private/10 text-private">only you</span>
        </div>
        <div className="divide-y divide-line">
          {addresses.map(([name, addr, chain]) => (
            <div key={addr} className="flex items-center gap-3 px-4 py-2.5 text-xs">
              <ChainIcon chain={chain} size={14} />
              <span className="min-w-0 flex-1 truncate font-medium text-ink">{name}</span>
              <span className="hash text-ink-faint">{addr}</span>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5 border-t border-line px-4 py-3 text-xs">
          {[
            ["CEX", C.signal],
            ["High volume", C.warn],
            ["Watched", C.inbound],
          ].map(([tag, color]) => (
            <span key={tag} className="inline-flex items-center gap-1.5 rounded-full bg-[var(--helium-elevated-7)] px-2.5 py-1 font-medium text-ink-dim">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
              {tag}
            </span>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between px-1 text-[11px] text-ink-faint">
        <span>Shows on address pages, graphs, traces and alerts</span>
        <span>CSV / JSON in and out</span>
      </div>
    </div>
  );
}

/* SVG helpers ---------------------------------------------------------------------------------- */

/** Shortens a segment by `start` and `end` so it meets circles' edges instead of their centres. */
function trim(x1: number, y1: number, x2: number, y2: number, start: number, end: number): [number, number, number, number] {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const d = Math.max(Math.hypot(dx, dy), 0.01);
  const ux = dx / d;
  const uy = dy / d;
  return [x1 + ux * start, y1 + uy * start, x2 - ux * end, y2 - uy * end];
}

function Arrowheads() {
  return (
    <defs>
      {(
        [
          ["in", C.inbound],
          ["out", C.outbound],
          ["bridge", C.signal],
        ] as const
      ).map(([id, color]) => (
        <marker key={id} id={`hf-arrow-${id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill={color} />
        </marker>
      ))}
    </defs>
  );
}

function Legend({ y, items }: { y: number; items: [string, string][] }) {
  let x = 0;
  return (
    <g transform={`translate(0 ${y})`}>
      {items.map(([label, color]) => {
        const at = x;
        x += 22 + label.length * 6.2;
        return (
          <g key={label} transform={`translate(${at} 0)`}>
            <circle cx="4" cy="-4" r="4" fill={color} />
            <text x="12" fontSize="10.5" fill={C.faint}>
              {label}
            </text>
          </g>
        );
      })}
    </g>
  );
}
