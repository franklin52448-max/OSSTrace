import type { Chain } from "@osstrace/contract";

/** One entry per chain this project has real data for (see @osstrace/contract's Chain type) -- no
 * entry for anything else, rather than fabricate a link to data we don't have. BscScan is BNB
 * Smart Chain's own explorer (Etherscan's, for chain 56), same /address/ and /tx/ paths. Robinhood
 * Chain's is its own official Blockscout instance, the same one the server reads it through. Base
 * links to BaseScan, its Etherscan-family explorer (the server reads Base through Blockscout's PRO
 * API, but that's a keyed data source, not where a person clicks through to). */
export const EXPLORERS: Record<Chain, { name: string; address: string; tx: string }> = {
  ethereum: { name: "Etherscan", address: "https://etherscan.io/address/", tx: "https://etherscan.io/tx/" },
  solana: { name: "Solscan", address: "https://solscan.io/account/", tx: "https://solscan.io/tx/" },
  bnb: { name: "BscScan", address: "https://bscscan.com/address/", tx: "https://bscscan.com/tx/" },
  robinhood: { name: "Blockscout", address: "https://robinhoodchain.blockscout.com/address/", tx: "https://robinhoodchain.blockscout.com/tx/" },
  base: { name: "BaseScan", address: "https://basescan.org/address/", tx: "https://basescan.org/tx/" },
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
