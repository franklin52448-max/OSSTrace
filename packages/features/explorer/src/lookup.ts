import type { Address, BalanceResult, ChainAdapter, Entity, Label, LabelStore, Tag, TransactionsResult } from "@osstrace/core";

export interface AddressReport {
  address: Address;
  /** `{ available: false, reason }` when the balance call failed — the rest of the report still stands (ADR 0014). */
  balance: BalanceResult;
  transactions: TransactionsResult;
  label: Label | null;
  tags: Tag[];
  entity: Entity | null;
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Orchestrates one chain adapter + the label store into a single report. No chain-specific logic lives here.
 *
 * The two chain calls are independent and each one's failure is reported in its own field: a
 * failed balance call (the RPC down, say) must not hide transaction history that came back fine,
 * nor the label/tags/entity, which are local reads with nothing to do with the RPC. Adapters
 * already report "couldn't fetch history" as `available: false`; a transaction call that throws
 * anyway is treated the same way rather than taking the balance down with it. Only a label-store
 * failure (a local read) still rejects the whole lookup.
 */
export async function lookupAddress(
  address: Address,
  adapter: ChainAdapter,
  store: LabelStore,
  txLimit = 25,
): Promise<AddressReport> {
  const balancePromise: Promise<BalanceResult> = adapter.getBalance(address.value).then(
    (balance): BalanceResult => ({ available: true, balance }),
    (cause: unknown): BalanceResult => ({ available: false, reason: reasonOf(cause) }),
  );
  const transactionsPromise: Promise<TransactionsResult> = adapter
    .getRecentTransactions(address.value, txLimit)
    .catch((cause: unknown): TransactionsResult => ({ available: false, reason: reasonOf(cause) }));

  const [balance, transactions, label, tags, entity] = await Promise.all([
    balancePromise,
    transactionsPromise,
    store.getLabel(address),
    store.getTags(address),
    store.getEntity(address),
  ]);
  return { address, balance, transactions, label, tags, entity };
}

/**
 * Whether a report is worth caching. A report whose balance call failed is not: before ADR 0014
 * that failure was a thrown error, so nothing was cached and the next lookup retried at once.
 * Caching it now would show "balance unavailable" for the whole TTL after the RPC recovered.
 */
export function isCacheableReport(report: AddressReport): boolean {
  return report.balance.available;
}
