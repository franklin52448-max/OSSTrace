// The home page's feature tour, under the hero. Each row is one feature: what it answers, the real
// limits it works within, and a small diagram drawn in the same colours the live views use
// (inbound green, outbound orange, labeled yellow, sanctioned red). Diagrams are illustrative: the
// addresses and amounts in them are placeholders, never real data.
import type { ReactNode } from "react";
import { cx } from "./prism/components.tsx";
import { IconArrowRight } from "./prism/icons.tsx";
import { ChainIcon } from "./ChainSelect.tsx";

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
  window.scrollTo({ top: 0, behavior: "smooth" });
  document.querySelector<HTMLInputElement>("main input[type=search], section input[type=search]")?.focus({ preventScroll: true });
}

export default function HomeFeatures() {
  return (
    <section id="features" className="mx-auto max-w-6xl scroll-mt-[103px] px-4 pt-20 sm:px-6 lg:scroll-mt-[65px]" aria-labelledby="features-title">
      <div className="mx-auto max-w-2xl text-center">
        <h2 id="features-title" className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          Every answer shows its evidence
        </h2>
        <p className="mt-4 text-[15px] leading-relaxed text-ink-dim">
          Each tool reads real chain data, says exactly how far it looked, and links every claim to its source. When a search
          runs out of budget, it says so instead of guessing.
        </p>
      </div>

      <div className="mt-16 space-y-20 sm:space-y-28">
        <FeatureRow
          name="Explorer"
          title="Look up any address"
          lead="Paste an Ethereum or Solana address to get its balance, recent transactions and anything on record about it, in one report."
          points={[
            "Balance and transaction history come straight from the chain (RPC and Etherscan), never estimated.",
            "A label only appears with a cited public source, like the OFAC or UK sanctions lists. No source, no label.",
            "Popular addresses stay warm in a background indexer, and new transactions are pushed to an open report live.",
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
          lead="Draws the address and every counterparty in its most recent transactions as an interactive graph."
          points={[
            "One hop, all real: each edge is an actual transfer with its direction, amount and transaction hash.",
            "Choose the last 5, 10, 25 or 50 transactions. Transfers it can't draw are listed with the reason.",
            "Select a counterparty and graph it next, stepping outward one real query at a time.",
          ]}
          action={<FeatureLink href="#graph">Open the Visualizer</FeatureLink>}
          diagram={<VisualizerDiagram />}
          flip
        />
        <FeatureRow
          name="Tracer"
          title="Follow the money, hop by hop"
          lead="Expands outward up to three hops, or answers a direct question: does a path connect address A to address B?"
          points={[
            "Path filters (token, minimum amount, time window) must hold on every hop, so a result is one continuous flow.",
            "Optionally follows Wormhole transfers between Ethereum and Solana and keeps tracing on the other chain.",
            "Every address it reached but didn't expand is listed with the reason: hop limit, breadth cap or call budget.",
          ]}
          action={<FeatureLink href="#trace">Open the Tracer</FeatureLink>}
          diagram={<TracerDiagram />}
        />
        <FeatureRow
          name="Risk score"
          title="Exposure, measured in hops"
          lead="Scores an address by how close it sits to a sanctioned one, and shows the exact path of transfers that got there."
          points={[
            "The address itself is 100. One hop away is 75, two is 50, three is 25. Only the nearest flagged address counts.",
            "Only sourced risk tags count (today: sanctions lists). Community labels never move a score.",
            "If the search couldn't finish, the result is “inconclusive”, never a reassuring zero.",
          ]}
          action={<FeatureLink href="#" onClick={focusHeroSearch}>Score an address from its report</FeatureLink>}
          diagram={<RiskDiagram />}
          flip
        />
        <FeatureRow
          name="Labels"
          title="Know who vouches for a label"
          lead="Every label carries a trust tier, so an official list, a community tip and your own note never look alike."
          points={[
            "Anyone with an account can suggest a label, but it must cite a source and is marked unreviewed until checked.",
            "Moderators confirm or reject submissions, with a reason the submitter sees. Nobody reviews their own.",
            "Private labels are notes only you can see. They have no source, no badge, and are never shared.",
          ]}
          diagram={<LabelsDiagram />}
        />
      </div>

      <div className="mt-24 grid gap-4 md:grid-cols-2">
        <MiniFeature
          href="#cases"
          name="Cases"
          title="Keep an investigation together"
          body="Group the addresses you're looking into, each with your own note, then close the case when you're done. Cases are private: not even moderators can see them."
          diagram={<CasesMini />}
        />
        <MiniFeature
          href="#bounties"
          name="Bounties"
          title="Fund the feature you need"
          body="Describe a feature and what you'll offer for it. Builders submit pull requests, and a moderator records the winner. Rewards are paid off-platform; the board only tracks them."
          diagram={<BountiesMini />}
        />
      </div>
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

function MiniFeature({ href, name, title, body, diagram }: { href: string; name: string; title: string; body: string; diagram: ReactNode }) {
  return (
    <a href={href} className="card group flex flex-col overflow-hidden transition-colors duration-200 hover:border-line-strong">
      <div className="graph-field border-b border-line px-5 py-5">{diagram}</div>
      <div className="flex flex-1 flex-col p-5">
        <h3 className="text-lg font-semibold tracking-tight text-ink">{title}</h3>
        <p className="mt-2 flex-1 text-sm leading-relaxed text-ink-dim">{body}</p>
        <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-ink transition-colors duration-150 group-hover:text-signal">
          Open {name}
          <IconArrowRight className="h-4 w-4 transition-transform duration-150 group-hover:translate-x-0.5" />
        </span>
      </div>
    </a>
  );
}

/* Diagrams ------------------------------------------------------------------------------------- */

/** A miniature address report, built from the same chips and figures the real one uses. */
function ExplorerDiagram() {
  return (
    <div className="space-y-3" aria-hidden="true">
      <div className="rounded-[14px] border border-line bg-panel">
        <div className="flex items-center gap-3 p-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--helium-elevated-10)]">
            <ChainIcon chain="ethereum" size={18} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-semibold text-ink">Example Mixer Pool</span>
              <span className="chip border-line-strong bg-raised text-ink-dim">verified</span>
              <span className="chip border-danger/40 bg-danger/15 text-danger">SANCTIONED</span>
            </div>
            <div className="hash mt-0.5 text-xs text-ink-faint">0x8f3a…c21a</div>
          </div>
        </div>
        <div className="grid grid-cols-3 border-t border-line text-xs">
          {[
            ["Balance", "1,204.5 ETH"],
            ["Recent txs", "25"],
            ["Tags", "1"],
          ].map(([k, v], i) => (
            <div key={k} className={cx("px-3 py-3 sm:px-4", i < 2 && "border-r border-line")}>
              <div className="text-ink-faint">{k}</div>
              <div className="num mt-0.5 whitespace-nowrap font-mono text-xs font-semibold text-ink sm:text-sm">{v}</div>
            </div>
          ))}
        </div>
        <div className="divide-y divide-line border-t border-line">
          {[
            ["2m ago", "+3.2 ETH", "text-inbound"],
            ["1h ago", "−0.8 ETH", "text-outbound"],
            ["5h ago", "+500 USDC", "text-inbound"],
          ].map(([t, v, tone]) => (
            <div key={t} className="flex items-center justify-between px-4 py-2 text-xs">
              <span className="text-ink-faint">{t}</span>
              <span className="hash text-ink-faint">0x41c2…9e0b</span>
              <span className={cx("num font-mono font-medium", tone)}>{v}</span>
            </div>
          ))}
        </div>
      </div>
      {/* The citation every label carries. */}
      <div className="flex items-center gap-2 pl-4 text-xs text-ink-faint">
        <svg width="18" height="18" viewBox="0 0 18 18" className="shrink-0">
          <path d="M3 0v9a4 4 0 0 0 4 4h8" fill="none" stroke={C.line} strokeWidth="1.5" />
          <path d="m12 10 3 3-3 3" fill="none" stroke={C.line} strokeWidth="1.5" />
        </svg>
        <span>
          Source: <span className="text-ink-dim underline decoration-line-strong underline-offset-2">public sanctions list entry</span> · added
          2026-03-14
        </span>
      </div>
    </div>
  );
}

/** One hop: the queried address in the middle, counterparties around it. */
function VisualizerDiagram() {
  const center = { x: 240, y: 150 };
  const nodes = [
    { x: 92, y: 70, dir: "in", r: 11 },
    { x: 90, y: 214, dir: "out", r: 8 },
    { x: 240, y: 36, dir: "in", r: 9, label: "Labeled exchange", tone: "warn" },
    { x: 392, y: 74, dir: "out", r: 12 },
    { x: 404, y: 210, dir: "in", r: 9 },
    { x: 250, y: 266, dir: "out", r: 10, tone: "danger" },
  ] as const;
  return (
    <svg viewBox="0 0 480 300" className="block h-auto w-full" role="img" aria-label="An address in the centre linked to six counterparties">
      <Arrowheads />
      {nodes.map((n, i) => {
        const inbound = n.dir === "in";
        const [a, b] = inbound ? [n, center] : [center, n];
        const [x1, y1, x2, y2] = trim(a.x, a.y, b.x, b.y, inbound ? n.r + 3 : 22, inbound ? 24 : n.r + 5);
        return (
          <line
            key={i}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={inbound ? C.inbound : C.outbound}
            strokeWidth="1.6"
            opacity="0.85"
            markerEnd={`url(#hf-arrow-${n.dir})`}
          />
        );
      })}
      {nodes.map((n, i) => {
        const stroke = "tone" in n ? (n.tone === "warn" ? C.warn : C.danger) : "#52525b";
        return (
          <g key={i}>
            <circle cx={n.x} cy={n.y} r={n.r} fill={C.raised} stroke={stroke} strokeWidth="2" />
            {"label" in n && (
              <text x={n.x + 16} y={n.y + 4} fontSize="11" fill={C.warn}>
                {n.label}
              </text>
            )}
          </g>
        );
      })}
      <circle cx={center.x} cy={center.y} r="24" fill="none" stroke={C.ink} strokeWidth="1.2" strokeDasharray="3 3" opacity="0.6" />
      <circle cx={center.x} cy={center.y} r="18" fill="#1d2a5d" stroke={C.signal} strokeWidth="3" />
      <text x={center.x + 32} y={center.y + 4} fontSize="11" fill={C.dim}>
        queried address
      </text>
      <Legend
        y={292}
        items={[
          ["in", C.inbound],
          ["out", C.outbound],
          ["labeled", C.warn],
          ["sanctioned", C.danger],
        ]}
      />
    </svg>
  );
}

/** A path across hops, with one Wormhole bridge hop onto Solana, and the branches not followed. */
function TracerDiagram() {
  const eth = 104;
  const sol = 224;
  const path = [
    { x: 48, y: eth, label: "A" },
    { x: 196, y: eth },
    { x: 300, y: sol },
    { x: 436, y: sol, label: "B" },
  ];
  const frontier = [
    { from: 0, x: 116, y: 36 },
    { from: 1, x: 252, y: 40 },
  ];
  return (
    <svg viewBox="0 0 480 300" className="block h-auto w-full" role="img" aria-label="A three-hop path from A to B that crosses from Ethereum to Solana through Wormhole">
      <Arrowheads />
      {/* Chain lanes. */}
      <text x="0" y={eth - 30} fontSize="10" fill={C.faint} letterSpacing="0.08em">
        ETHEREUM
      </text>
      <line x1="0" y1={eth + 34} x2="480" y2={eth + 34} stroke={C.line} strokeDasharray="2 5" />
      <text x="0" y={sol + 50} fontSize="10" fill={C.faint} letterSpacing="0.08em">
        SOLANA
      </text>

      {/* Filter applied to every hop. */}
      <g transform="translate(286 262)">
        <rect width="194" height="24" rx="12" fill={C.panel} stroke={C.line} />
        <text x="97" y="16" fontSize="10.5" fill={C.dim} textAnchor="middle">
          USDC ≥ 100 · last 30 days · every hop
        </text>
      </g>

      {frontier.map((f, i) => {
        const a = path[f.from]!;
        const [x1, y1, x2, y2] = trim(a.x, a.y, f.x, f.y, 12, 8);
        return (
          <g key={i} opacity="0.55">
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={C.faint} strokeWidth="1.2" strokeDasharray="3 3" />
            <circle cx={f.x} cy={f.y} r="6" fill="none" stroke={C.faint} strokeWidth="1.5" strokeDasharray="2 2" />
          </g>
        );
      })}
      <text x="266" y="44" fontSize="10" fill={C.faint}>
        reached, not expanded
      </text>

      {path.slice(0, -1).map((a, i) => {
        const b = path[i + 1]!;
        const bridge = a.y !== b.y;
        const [x1, y1, x2, y2] = trim(a.x, a.y, b.x, b.y, 12, 14);
        return (
          <g key={i}>
            <line
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={bridge ? C.signal : C.outbound}
              strokeWidth="1.8"
              strokeDasharray={bridge ? "5 4" : undefined}
              markerEnd={bridge ? "url(#hf-arrow-bridge)" : "url(#hf-arrow-out)"}
            />
            <text x={(a.x + b.x) / 2 + (bridge ? -12 : 0)} y={(a.y + b.y) / 2 + (bridge ? 4 : -10)} fontSize="10" fill={C.faint} textAnchor={bridge ? "end" : "middle"}>
              hop {i + 1}
            </text>
          </g>
        );
      })}
      <g transform="translate(262 152)">
        <rect width="76" height="22" rx="11" fill="#1d2a5d" stroke={C.signal} />
        <text x="38" y="15" fontSize="10.5" fill={C.signal} textAnchor="middle">
          Wormhole
        </text>
      </g>

      {path.map((n, i) => (
        <g key={i}>
          <circle cx={n.x} cy={n.y} r={n.label ? 13 : 9} fill={n.label ? "#1d2a5d" : C.raised} stroke={n.label ? C.signal : "#52525b"} strokeWidth="2" />
          {n.label && (
            <text x={n.x} y={n.y + 4} fontSize="11" fontWeight="600" fill={C.ink} textAnchor="middle">
              {n.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

/** Rings of hop distance around the address; the nearest sanctioned address sets the score. */
function RiskDiagram() {
  const cx0 = 170;
  const cy0 = 150;
  const rings = [
    { r: 46, label: "1 hop" },
    { r: 84, label: "2 hops" },
    { r: 122, label: "3 hops" },
  ];
  const hop1 = { x: cx0 + 30, y: cy0 - 35 };
  const hit = { x: cx0 + 74, y: cy0 - 40 };
  const far = { x: cx0 - 86, y: cy0 + 86 };
  return (
    <svg viewBox="0 0 480 300" className="block h-auto w-full" role="img" aria-label="A sanctioned address two hops away gives a score of 50">
      <Arrowheads />
      {rings.map((ring, i) => (
        <circle key={ring.r} cx={cx0} cy={cy0} r={ring.r} fill={C.danger} fillOpacity={0.09 - i * 0.025} stroke={C.line} strokeDasharray="2 4" />
      ))}
      {/* Path to the nearest flagged address. */}
      {[
        [cx0, cy0, hop1.x, hop1.y, 18, 9],
        [hop1.x, hop1.y, hit.x, hit.y, 9, 11],
      ].map(([x1, y1, x2, y2, s, e], i) => {
        const [a, b, c, d] = trim(x1!, y1!, x2!, y2!, s!, e!);
        return <line key={i} x1={a} y1={b} x2={c} y2={d} stroke={C.outbound} strokeWidth="1.8" markerEnd="url(#hf-arrow-out)" />;
      })}
      <circle cx={hop1.x} cy={hop1.y} r="7" fill={C.raised} stroke="#52525b" strokeWidth="2" />
      <circle cx={hit.x} cy={hit.y} r="9" fill="#3b1a2a" stroke={C.danger} strokeWidth="2" />
      {/* A farther flagged address: listed, but it doesn't add to the score. */}
      <circle cx={far.x} cy={far.y} r="7" fill="#3b1a2a" stroke={C.danger} strokeWidth="1.5" opacity="0.6" />
      <circle cx={cx0} cy={cy0} r="16" fill="#1d2a5d" stroke={C.signal} strokeWidth="3" />

      {rings.map((ring) => (
        <text key={ring.label} x={cx0} y={cy0 + ring.r - 6} fontSize="10" fill={C.faint} textAnchor="middle">
          {ring.label}
        </text>
      ))}
      <g transform="translate(320 70)">
        <text fontSize="10" fill={C.faint} letterSpacing="0.08em">
          NEAREST FLAG → SCORE
        </text>
        {[
          ["itself", 100, false],
          ["1 hop", 75, false],
          ["2 hops", 50, true],
          ["3 hops", 25, false],
          ["none", 0, false],
        ].map(([k, v, on], i) => (
          <g key={String(k)} transform={`translate(0 ${22 + i * 24})`}>
            {on && <rect x="-8" y="-14" width="160" height="22" rx="11" fill={C.danger} fillOpacity="0.14" stroke={C.danger} strokeOpacity="0.45" />}
            <text fontSize="12" fill={on ? C.ink : C.dim}>
              {k}
            </text>
            <text x="140" fontSize="12" fontFamily="var(--font-mono)" fill={on ? C.danger : C.dim} textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        <text y="160" fontSize="10.5" fill={C.warn}>
          search incomplete → inconclusive
        </text>
      </g>
    </svg>
  );
}

/** The four trust tiers, rendered with the same badges the live views use. */
function LabelsDiagram() {
  const tiers: { badge: ReactNode; name: string; who: string; className?: string }[] = [
    {
      badge: <span className="chip border-line-strong bg-raised text-ink-dim">official source</span>,
      name: "OFAC SDN · UK Sanctions List",
      who: "Ingested from a published list, with the entry cited.",
    },
    {
      badge: <span className="chip border-info/35 bg-info/10 text-info">✓ CONFIRMED</span>,
      name: "Community label, reviewed",
      who: "A moderator checked the cited source and confirmed it.",
    },
    {
      badge: <span className="chip border-warn/35 bg-warn/10 text-warn">COMMUNITY · UNREVIEWED</span>,
      name: "Community label, pending",
      who: "Public right away, clearly marked until someone reviews it.",
    },
    {
      badge: <span className="chip border-private/45 bg-private/10 text-private">only you</span>,
      name: "“my cold wallet”",
      who: "Your private note. Never public, never a source.",
      className: "border-dashed border-private/45 bg-private/[0.06]",
    },
  ];
  return (
    <div className="relative space-y-2.5" aria-hidden="true">
      {tiers.map((tier, i) => (
        <div key={tier.name} className={cx("flex items-start gap-3 rounded-[14px] border border-line bg-panel px-4 py-3", tier.className)}>
          <span className="num mt-0.5 w-4 shrink-0 font-mono text-xs text-ink-faint">{i + 1}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-ink">{tier.name}</span>
              {tier.badge}
            </div>
            <p className="mt-1 text-xs text-ink-faint">{tier.who}</p>
          </div>
        </div>
      ))}
      <div className="flex items-center justify-between px-1 pt-1 text-[11px] text-ink-faint">
        <span>more trust ↑</span>
        <span>every public label cites a source</span>
      </div>
    </div>
  );
}

function CasesMini() {
  return (
    <div className="flex items-center gap-3" aria-hidden="true">
      <div className="min-w-0 flex-1 space-y-1.5">
        {[
          ["0x8f3a…c21a", "funds arrived from the exploit"],
          ["0x41c2…9e0b", "likely the cash-out wallet"],
          ["7xKX…AsU", "bridged leg on Solana"],
        ].map(([addr, note]) => (
          <div key={addr} className="flex items-center gap-2 rounded-[10px] border border-line bg-panel px-3 py-1.5 text-xs">
            <span className="hash shrink-0 text-ink">{addr}</span>
            <span className="truncate text-ink-faint">{note}</span>
          </div>
        ))}
      </div>
      <span className="chip shrink-0 self-start border-signal/35 bg-signal/10 text-signal">open</span>
    </div>
  );
}

function BountiesMini() {
  const steps = ["Open", "PRs submitted", "Claimed"];
  return (
    <div aria-hidden="true">
      <div className="flex items-center justify-between rounded-[10px] border border-line bg-panel px-3 py-2 text-xs">
        <span className="truncate font-medium text-ink">Add Base chain support</span>
        <span className="num shrink-0 font-mono text-ink-dim">reward: poster's offer</span>
      </div>
      <div className="mt-4 flex items-center">
        {steps.map((step, i) => (
          <div key={step} className="flex flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center gap-1.5">
              <span className={cx("h-2.5 w-2.5 rounded-full", i < 2 ? "bg-signal" : "border border-line-strong bg-raised")} />
              <span className="whitespace-nowrap text-[11px] text-ink-faint">{step}</span>
            </div>
            {i < steps.length - 1 && <span className={cx("mx-2 mb-5 h-px flex-1", i < 1 ? "bg-signal" : "bg-line-strong")} />}
          </div>
        ))}
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
