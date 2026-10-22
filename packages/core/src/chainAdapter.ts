import type { Balance, ChainId, TransactionsPageOptions, TransactionsResult } from "./types.ts";

/**
 * The one interface every chain package implements. See packages/chains/README.md before adding
 * a new one — nothing outside your chain's own folder should need to change.
 */
export interface ChainAdapter {
  readonly chain: ChainId;
  getBalance(address: string): Promise<Balance>;
  /**
   * Newest first, at most `limit`. With `options.before` (a `nextCursor` this adapter returned),
   * the page after that one. An adapter that can't parse the cursor returns `available: false`
   * with a reason, the same as any other "couldn't fetch".
   */
  getRecentTransactions(address: string, limit: number, options?: TransactionsPageOptions): Promise<TransactionsResult>;
}
