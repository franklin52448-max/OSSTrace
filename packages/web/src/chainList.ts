import { CHAIN_NAMES, CHAINS } from "@osstrace/contract";

/** Every supported chain's display name as one phrase -- "Ethereum, BNB Chain, ..., Data Network or
 *  Solana" -- Ethereum first and Solana last, the order the copy has always used. Built from the shared
 *  chain list, so a page's "paste a ... address" line can't fall behind when a chain is added. */
export function supportedChainNames(conjunction: "and" | "or"): string {
  const names = [...CHAINS.filter((c) => c !== "solana"), "solana" as const].map((c) => CHAIN_NAMES[c]);
  return `${names.slice(0, -1).join(", ")} ${conjunction} ${names.at(-1)}`;
}
