import type { Chain } from "@osstrace/contract";

/** One entry per chain this project has real data for (see @osstrace/contract's Chain type) -- no
 * entry for anything else, rather than fabricate a link to data we don't have. BscScan is BNB
 * Smart Chain's own explorer (Etherscan's, for chain 56), same /address/ and /tx/ paths. Robinhood
 * Chain's is its own official Blockscout instance. Base links to BaseScan, its Etherscan-family
 * explorer. Arbitrum One links to Arbiscan and OP Mainnet to Optimistic Etherscan (each chain's
 * Etherscan-family explorer); Zora and Lens Chain to their own official explorers, and the Data
 * Network to datanetscan.io, its Blockscout instance (storyscan.io, its name as Story, now redirects
 * there). Gnosis Chain links to Gnosisscan (its Etherscan-family explorer), Ronin to Ronin's own
 * official explorer (explorer.roninchain.com, a Blockscout instance), and Rootstock to the Rootstock
 * Explorer (explorer.rootstock.io; explorer.rsk.co redirects there). ZetaChain links to ZetaScan
 * (zetascan.com, the explorer ZetaChain's own docs name -- a Blockscout instance), Mythos to its own
 * explorer (mythos-mainnet.explorer.alchemy.com, an Alchemy-hosted Blockscout that names itself "Mythos
 * Mainnet"), and the HyperEVM to HyperEVMScan (hyperevmscan.io, the first explorer Hyperliquid's own docs
 * list). (The server reads every EVM chain
 * but Ethereum through Alchemy -- packages/server/src/chain/alchemy.ts -- which is a keyed data source,
 * not somewhere a person clicks through to.) */
export const EXPLORERS: Record<Chain, { name: string; address: string; tx: string }> = {
  ethereum: { name: "Etherscan", address: "https://etherscan.io/address/", tx: "https://etherscan.io/tx/" },
  solana: { name: "Solscan", address: "https://solscan.io/account/", tx: "https://solscan.io/tx/" },
  bnb: { name: "BscScan", address: "https://bscscan.com/address/", tx: "https://bscscan.com/tx/" },
  robinhood: { name: "Blockscout", address: "https://robinhoodchain.blockscout.com/address/", tx: "https://robinhoodchain.blockscout.com/tx/" },
  base: { name: "BaseScan", address: "https://basescan.org/address/", tx: "https://basescan.org/tx/" },
  arbitrum: { name: "Arbiscan", address: "https://arbiscan.io/address/", tx: "https://arbiscan.io/tx/" },
  optimism: { name: "Optimistic Etherscan", address: "https://optimistic.etherscan.io/address/", tx: "https://optimistic.etherscan.io/tx/" },
  zora: { name: "Zora Explorer", address: "https://explorer.zora.energy/address/", tx: "https://explorer.zora.energy/tx/" },
  lens: { name: "Lens Explorer", address: "https://explorer.lens.xyz/address/", tx: "https://explorer.lens.xyz/tx/" },
  story: { name: "DataNetScan", address: "https://www.datanetscan.io/address/", tx: "https://www.datanetscan.io/tx/" },
  gnosis: { name: "Gnosisscan", address: "https://gnosisscan.io/address/", tx: "https://gnosisscan.io/tx/" },
  ronin: { name: "Ronin Explorer", address: "https://explorer.roninchain.com/address/", tx: "https://explorer.roninchain.com/tx/" },
  rootstock: { name: "Rootstock Explorer", address: "https://explorer.rootstock.io/address/", tx: "https://explorer.rootstock.io/tx/" },
  zetachain: { name: "ZetaScan", address: "https://zetascan.com/address/", tx: "https://zetascan.com/tx/" },
  mythos: { name: "Mythos Explorer", address: "https://mythos-mainnet.explorer.alchemy.com/address/", tx: "https://mythos-mainnet.explorer.alchemy.com/tx/" },
  hyperliquid: { name: "HyperEVMScan", address: "https://hyperevmscan.io/address/", tx: "https://hyperevmscan.io/tx/" },
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
