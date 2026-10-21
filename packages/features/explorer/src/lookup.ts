import type { Address, Balance, ChainAdapter, Entity, Label, LabelStore, Tag, TransactionsResult } from "@osstrace/core";

export interface AddressReport {
  address: Address;
  balance: Balance;
  transactions: TransactionsResult;
  label: Label | null;
  tags: Tag[];
  entity: Entity | null;
}

/** Orchestrates one chain adapter + the label store into a single report. No chain-specific logic lives here. */
export async function lookupAddress(
  address: Address,
  adapter: ChainAdapter,
  store: LabelStore,
  txLimit = 25,
): Promise<AddressReport> {
  const [balance, transactions, label, tags, entity] = await Promise.all([
    adapter.getBalance(address.value),
    adapter.getRecentTransactions(address.value, txLimit),
    store.getLabel(address),
    store.getTags(address),
    store.getEntity(address),
  ]);
  return { address, balance, transactions, label, tags, entity };
}
