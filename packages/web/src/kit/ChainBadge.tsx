import { CHAIN_NAMES as NAME, NATIVE_SYMBOLS, type Chain } from "@osstrace/contract";
import { cn } from "./cn.ts";

/** A chain's short code. Usually its native symbol -- but Robinhood Chain's, Base's, Arbitrum One's,
 *  OP Mainnet's and Zora's native unit is "ETH" too, and a badge reading "ETH" would make their rows
 *  indistinguishable from Ethereum's. Lens Chain's native GHO is also an Ethereum token, so it gets
 *  "LENS"; the Data Network's DATA is its own and stays. Gnosis Chain's xDAI is bridged DAI -- an
 *  Ethereum token too -- so it gets "GNO" (the chain's own short code); Ronin's RON and Rootstock's
 *  RBTC are each that chain's own and stay. */
export const CHAIN_SHORT: Record<Chain, string> = { ...NATIVE_SYMBOLS, robinhood: "RH", base: "BASE", arbitrum: "ARB", optimism: "OP", zora: "ZORA", lens: "LENS", gnosis: "GNO" };
const SHORT = CHAIN_SHORT;

/** Text badge for a chain (no third-party logos). */
export function ChainBadge({ chain, className, long }: { chain: Chain; className?: string; long?: boolean }) {
  return (
    <span title={NAME[chain]} className={cn("kit-mono inline-flex h-5 shrink-0 items-center rounded-[4px] border border-border bg-surface-2 px-1.5 text-[11px] font-medium tracking-[0.06em] text-muted", className)}>
      {long ? NAME[chain] : SHORT[chain]}
    </span>
  );
}
