// Chain picker with each chain's mark. A native <select> can't show images in its options, so this
// is a small listbox: button + popup, keyboard-operable (arrows / Home / End / Enter / Escape).
//
// Marks: Simple Icons (https://simpleicons.org, CC0-1.0), filled in each project's brand colours --
// except Base's, which is drawn here rather than copied: a plain disc in Base's own brand blue. The
// five chains after it are drawn the same honest way, never a from-memory copy of brand artwork:
// Arbitrum One a navy disc with a blue ring, OP Mainnet a disc in OP's red, Zora a black disc with a
// white ring, Lens Chain a disc in Lens's dark green, and the Data Network (formerly Story), whose
// new branding isn't one to guess at, a neutral grey disc with a "D". Gnosis Chain, Ronin and
// Rootstock likewise, each a disc in its brand's general colour family with a ring so none reads as
// a neighbour's plain disc (Lens's green, Base's blue, the deposit panel's orange Bitcoin "₿"): Gnosis
// Chain dark green with a cream ring, Ronin blue with a white ring, Rootstock orange with a black ring.
import { useEffect, useId, useRef, useState } from "react";
import { CHAIN_NAMES, type Chain } from "@osstrace/contract";
import { cx } from "./prism/components.tsx";
import { IconCheck, IconChevronDown } from "./prism/icons.tsx";

export const CHAIN_OPTIONS: readonly { value: Chain; label: string }[] = [
  { value: "ethereum", label: CHAIN_NAMES.ethereum },
  { value: "solana", label: CHAIN_NAMES.solana },
  { value: "bnb", label: CHAIN_NAMES.bnb },
  { value: "robinhood", label: CHAIN_NAMES.robinhood },
  { value: "base", label: CHAIN_NAMES.base },
  { value: "arbitrum", label: CHAIN_NAMES.arbitrum },
  { value: "optimism", label: CHAIN_NAMES.optimism },
  { value: "zora", label: CHAIN_NAMES.zora },
  { value: "lens", label: CHAIN_NAMES.lens },
  { value: "story", label: CHAIN_NAMES.story },
  { value: "gnosis", label: CHAIN_NAMES.gnosis },
  { value: "ronin", label: CHAIN_NAMES.ronin },
  { value: "rootstock", label: CHAIN_NAMES.rootstock },
];

/** Base's brand blue (base.org's "Base Blue"). */
const BASE_BLUE = "#0052FF";
/** Arbitrum's navy and blue. */
const ARBITRUM_NAVY = "#213147";
const ARBITRUM_BLUE = "#28A0F0";
/** OP Mainnet's red. */
const OP_RED = "#FF0420";
/** Lens's dark green. */
const LENS_GREEN = "#00501E";
/** A neutral grey: no brand colour is claimed for the Data Network. */
const NEUTRAL_GREY = "#6B7280";
/** General colour families, not claimed as exact brand values: Gnosis's dark green and cream, Ronin's
 *  blue, Rootstock's orange. */
const GNOSIS_GREEN = "#133629";
const GNOSIS_CREAM = "#F0EBDE";
const RONIN_BLUE = "#1273EA";
const ROOTSTOCK_ORANGE = "#FF9100";

/** A plain disc, optionally with an inner ring -- the honest generic mark for a chain whose exact
 *  brand artwork isn't copied here. */
function DiscMark({ fill, ring, size, className, letter }: { fill: string; ring?: string; size: number; className?: string; letter?: "D" }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className={cx("shrink-0", className)}>
      <circle cx="12" cy="12" r="12" fill={fill} />
      {ring && <circle cx="12" cy="12" r="7" fill="none" stroke={ring} strokeWidth="2.5" />}
      {/* Drawn, not <text>: a glyph would leak into the option's own text ("DData Network"). */}
      {letter === "D" && <path d="M9 7h2.5a5 5 0 0 1 0 10H9z" fill="none" stroke="#ffffff" strokeWidth="2" strokeLinejoin="round" />}
    </svg>
  );
}

/** The chains the older standalone feature services (pathfinder, cases...) were built for. Their
 *  own backends only know these two, so their pickers must not offer a chain they'd reject. */
export const LEGACY_SERVICE_CHAINS = ["ethereum", "solana"] as const satisfies readonly Chain[];

export function ChainIcon({ chain, size = 18, className }: { chain: Chain; size?: number; className?: string }) {
  const gradientId = useId();
  if (chain === "arbitrum") return <DiscMark fill={ARBITRUM_NAVY} ring={ARBITRUM_BLUE} size={size} className={className} />;
  if (chain === "optimism") return <DiscMark fill={OP_RED} size={size} className={className} />;
  if (chain === "zora") return <DiscMark fill="#000000" ring="#ffffff" size={size} className={className} />;
  if (chain === "lens") return <DiscMark fill={LENS_GREEN} size={size} className={className} />;
  if (chain === "story") return <DiscMark fill={NEUTRAL_GREY} letter="D" size={size} className={className} />;
  if (chain === "gnosis") return <DiscMark fill={GNOSIS_GREEN} ring={GNOSIS_CREAM} size={size} className={className} />;
  if (chain === "ronin") return <DiscMark fill={RONIN_BLUE} ring="#ffffff" size={size} className={className} />;
  if (chain === "rootstock") return <DiscMark fill={ROOTSTOCK_ORANGE} ring="#000000" size={size} className={className} />;
  if (chain === "base") {
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className={cx("shrink-0", className)}>
        <circle cx="12" cy="12" r="12" fill={BASE_BLUE} />
      </svg>
    );
  }
  if (chain === "robinhood") {
    // Robinhood's feather, on Robinhood Chain's own lime disc: the same Simple Icons (CC0) path and
    // colours the home page's chain row already uses for it (HomeFeatures.tsx), copied from that
    // vetted path rather than redrawn from memory -- the same approach as the BNB mark below.
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className={cx("shrink-0", className)}>
        <circle cx="12" cy="12" r="12" fill="#CCFF00" />
        <path
          transform="translate(4.8 4.8) scale(0.6)"
          fill="#000000"
          d="M2.84 24h.53c.096 0 .192-.048.224-.128C7.591 13.696 11.94 8.656 14.67 5.638c.112-.128.064-.225-.096-.225h-4.88a.55.55 0 0 0-.45.225L5.746 9.972c-.514.642-.642 1.236-.642 2.086v4.43c-1.14 3.194-1.862 5.361-2.392 7.32-.032.125.016.192.129.192M20.447.646c-.754-.802-4.157-.834-5.73-.224a3 3 0 0 0-.786.465 41 41 0 0 0-3.323 3.178c-.112.113-.064.225.097.225h5.409c.497 0 .786.289.786.786v6.1c0 .16.128.208.225.064l3.258-4.254c.53-.69.69-.898.835-1.861.192-1.413.08-3.58-.77-4.479m-6.982 16.18 2.231-3.676a.7.7 0 0 0 .064-.29V6.73c0-.16-.112-.225-.224-.097-3.355 3.74-5.971 7.672-8.395 12.407-.06.12.016.225.16.177l5.009-1.54c.565-.174.882-.402 1.155-.852"
        />
      </svg>
    );
  }
  if (chain === "bnb") {
    // The BNB mark (a diamond of diamonds) is the same Simple Icons path the home page already uses
    // for Binance, here in BNB's own brand yellow on no disc -- copied from that vetted CC0 path
    // rather than redrawn from memory.
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className={cx("shrink-0", className)}>
        <path
          fill="#F0B90B"
          d="M16.624 13.9202l2.7175 2.7154-7.353 7.353-7.353-7.352 2.7175-2.7164 4.6355 4.6595 4.6356-4.6595zm4.6366-4.6366L24 12l-2.7154 2.7164L18.5682 12l2.6924-2.7164zm-9.272.001l2.7163 2.6914-2.7164 2.7174v-.001L9.2721 12l2.7164-2.7154zm-9.2722-.001L5.4088 12l-2.6914 2.6924L0 12l2.7164-2.7164zM11.9885.0115l7.353 7.329-2.7174 2.7154-4.6356-4.6356-4.6355 4.6595-2.7174-2.7154 7.353-7.353z"
        />
      </svg>
    );
  }
  if (chain === "ethereum") {
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className={cx("shrink-0", className)}>
        <path
          fill="#627EEA"
          d="M11.944 17.97L4.58 13.62 11.943 24l7.37-10.38-7.372 4.35h.003zM12.056 0L4.69 12.223l7.365 4.354 7.365-4.35L12.056 0z"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className={cx("shrink-0", className)}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="24" x2="24" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#9945FF" />
          <stop offset="1" stopColor="#14F195" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${gradientId})`}
        d="m23.8764 18.0313-3.962 4.1393a.9201.9201 0 0 1-.306.2106.9407.9407 0 0 1-.367.0742H.4599a.4689.4689 0 0 1-.2522-.0733.4513.4513 0 0 1-.1696-.1962.4375.4375 0 0 1-.0314-.2545.4438.4438 0 0 1 .117-.2298l3.9649-4.1393a.92.92 0 0 1 .3052-.2102.9407.9407 0 0 1 .3658-.0746H23.54a.4692.4692 0 0 1 .2523.0734.4531.4531 0 0 1 .1697.196.438.438 0 0 1 .0313.2547.4442.4442 0 0 1-.1169.2297zm-3.962-8.3355a.9202.9202 0 0 0-.306-.2106.941.941 0 0 0-.367-.0742H.4599a.4687.4687 0 0 0-.2522.0734.4513.4513 0 0 0-.1696.1961.4376.4376 0 0 0-.0314.2546.444.444 0 0 0 .117.2297l3.9649 4.1394a.9204.9204 0 0 0 .3052.2102c.1154.049.24.0744.3658.0746H23.54a.469.469 0 0 0 .2523-.0734.453.453 0 0 0 .1697-.1961.4382.4382 0 0 0 .0313-.2546.4444.4444 0 0 0-.1169-.2297zM.46 6.7225h18.7815a.9411.9411 0 0 0 .367-.0742.9202.9202 0 0 0 .306-.2106l3.962-4.1394a.4442.4442 0 0 0 .117-.2297.4378.4378 0 0 0-.0314-.2546.453.453 0 0 0-.1697-.196.469.469 0 0 0-.2523-.0734H4.7596a.941.941 0 0 0-.3658.0745.9203.9203 0 0 0-.3052.2102L.1246 5.9687a.4438.4438 0 0 0-.1169.2295.4375.4375 0 0 0 .0312.2544.4512.4512 0 0 0 .1692.196.4689.4689 0 0 0 .2518.0739z"
      />
    </svg>
  );
}

export function ChainSelect<C extends Chain = Chain>({
  value,
  onChange,
  chains,
  small,
  fullWidth,
  label = "Chain",
  className,
}: {
  value: C;
  onChange: (chain: C) => void;
  /** Only offer these (e.g. LEGACY_SERVICE_CHAINS for a backend that doesn't know every chain). */
  chains?: readonly C[];
  small?: boolean;
  /** Fill the parent's width (form fields), chevron at the far end. */
  fullWidth?: boolean;
  /** What the picker chooses, for assistive tech: "Chain", "To chain", … */
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const options = (chains ? CHAIN_OPTIONS.filter((o) => (chains as readonly Chain[]).includes(o.value)) : CHAIN_OPTIONS) as readonly { value: C; label: string }[];
  const current = options.find((o) => o.value === value) ?? options[0]!;

  // Close on an outside click.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  function openList(): void {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  }

  function choose(index: number): void {
    const option = options[index];
    if (option) onChange(option.value);
    setOpen(false);
    buttonRef.current?.focus();
  }

  function onListKeyDown(e: React.KeyboardEvent): void {
    const last = options.length - 1;
    const moves: Record<string, () => void> = {
      ArrowDown: () => setActive((i) => Math.min(last, i + 1)),
      ArrowUp: () => setActive((i) => Math.max(0, i - 1)),
      Home: () => setActive(0),
      End: () => setActive(last),
      Enter: () => choose(active),
      " ": () => choose(active),
      Escape: () => {
        setOpen(false);
        buttonRef.current?.focus();
      },
      Tab: () => setOpen(false),
    };
    const move = moves[e.key];
    if (!move) return;
    if (e.key !== "Tab") e.preventDefault();
    move();
  }

  return (
    <div ref={rootRef} className={cx("relative shrink-0", className)}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`${label}: ${current.label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            openList();
          }
        }}
        className={cx(
          "flex items-center gap-2 rounded-ctl bg-[var(--helium-elevated-7)] font-medium text-ink transition-colors duration-200 hover:bg-[var(--helium-elevated-10)]",
          // In a form field it matches the `.ctl` inputs beside it (same padding and type size).
          fullWidth ? "min-h-[41px] w-full py-2.5 pl-3.5 pr-3 text-sm" : small ? "h-9 pl-3 pr-2.5 text-sm" : "h-[42px] pl-3.5 pr-3 text-[15px]",
          open && "bg-[var(--helium-elevated-10)]",
        )}
      >
        <ChainIcon chain={current.value} size={small ? 16 : 18} />
        {current.label}
        <IconChevronDown className={cx("h-4 w-4 text-ink-faint transition-transform duration-200", fullWidth && "ml-auto", open && "rotate-180")} />
      </button>

      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={`${listId}-${active}`}
          onKeyDown={onListKeyDown}
          className="card absolute left-0 top-[calc(100%+6px)] z-40 min-w-full p-1 outline-none"
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={option.value === value}
              onPointerEnter={() => setActive(index)}
              onClick={() => choose(index)}
              className={cx(
                "flex cursor-pointer items-center gap-2.5 whitespace-nowrap rounded-[10px] py-2 pl-2.5 pr-3 text-sm font-medium text-ink",
                index === active && "bg-[var(--helium-elevated-10)]",
              )}
            >
              <ChainIcon chain={option.value} />
              <span className="flex-1">{option.label}</span>
              <IconCheck className={cx("h-4 w-4 text-ink-dim", option.value !== value && "invisible")} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
