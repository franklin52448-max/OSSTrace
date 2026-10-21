import type { Balance, ChainId, TransactionsResult } from "./types.ts";

/**
 * The one interface every chain package implements. See packages/chains/README.md before adding
 * a new one — nothing outside your chain's own folder should need to change.
 */
export interface ChainAdapter {
  readonly chain: ChainId;
  getBalance(address: string): Promise<Balance>;
  getRecentTransactions(address: string, limit: number): Promise<TransactionsResult>;
}
