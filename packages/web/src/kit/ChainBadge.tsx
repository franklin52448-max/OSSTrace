import { CHAIN_NAMES as NAME, NATIVE_SYMBOLS, type Chain } from "@osstrace/contract";
import { cn } from "./cn.ts";

/** A chain's short code. Usually its native symbol -- but Robinhood Chain's native unit is "ETH"
 *  too, and a badge reading "ETH" would make its rows indistinguishable from Ethereum's. */
const SHORT: Record<Chain, string> = { ...NATIVE_SYMBOLS, robinhood: "RH" };

/** Text badge for a chain (no third-party logos). */
export function ChainBadge({ chain, className, long }: { chain: Chain; className?: string; long?: boolean }) {
  return (
    <span title={NAME[chain]} className={cn("kit-mono inline-flex h-5 shrink-0 items-center rounded-[4px] border border-border bg-surface-2 px-1.5 text-[11px] font-medium tracking-[0.06em] text-muted", className)}>
      {long ? NAME[chain] : SHORT[chain]}
    </span>
  );
}
