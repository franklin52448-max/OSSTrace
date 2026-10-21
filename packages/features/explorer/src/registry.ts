import type { ChainAdapter, ChainId } from "@opentrace/core";
import { EthereumAdapter } from "@opentrace/chain-ethereum";
import { SolanaAdapter } from "@opentrace/chain-solana";

export interface RegistryConfig {
  ethRpcUrl: string;
  etherscanApiKey?: string | undefined;
  solanaRpcUrl: string;
}

/**
 * The one place that knows about every chain. Adding a new chain means adding one line here —
 * see packages/chains/README.md.
 */
export function buildRegistry(config: RegistryConfig): Map<ChainId, ChainAdapter> {
  const registry = new Map<ChainId, ChainAdapter>();
  registry.set("ethereum", new EthereumAdapter({ rpcUrl: config.ethRpcUrl, etherscanApiKey: config.etherscanApiKey }));
  registry.set("solana", new SolanaAdapter({ rpcUrl: config.solanaRpcUrl }));
  return registry;
}
