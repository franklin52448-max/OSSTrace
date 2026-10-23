import type { Chain } from "@osstrace/contract";

/** This project only has real data for these two chains (see @osstrace/contract's Chain type) --
 * no entry here for anything else, rather than fabricate a link to data we don't have. Adding a
 * real third chain later is a one-line addition. */
export const EXPLORERS: Record<Chain, { name: string; address: string; tx: string }> = {
  ethereum: { name: "Etherscan", address: "https://etherscan.io/address/", tx: "https://etherscan.io/tx/" },
  solana: { name: "Solscan", address: "https://solscan.io/account/", tx: "https://solscan.io/tx/" },
};

export function explorerName(chain: Chain): string {
  return EXPLORERS[chain].name;
}

export function explorerAddressUrl(chain: Chain, address: string): string {
  return `${EXPLORERS[chain].address}${address}`;
}

export function explorerTxUrl(chain: Chain, hash: string): string {
  return `${EXPLORERS[chain].tx}${hash}`;
}
