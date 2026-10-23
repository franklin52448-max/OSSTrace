export type BalanceRow = { tokenId: string; symbol: string | null; name: string | null; amount: string; price: number | null; usd: number | null };
export type BalanceSortKey = "asset" | "holdings" | "price" | "value";
export type BalanceSortDir = "asc" | "desc";

/** Same toggle-on-reclick convention as CounterpartiesPanel/TransferTable's sortBy. */
export function nextBalanceSort(current: { key: BalanceSortKey; dir: BalanceSortDir }, key: BalanceSortKey): { key: BalanceSortKey; dir: BalanceSortDir } {
  return current.key === key ? { key, dir: current.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" };
}

/** `amount`/`price`/`usd` compare numerically (amount is a decimal string, not an integer --
 * Number(), not BigInt). A null price/usd always sorts last regardless of direction: an unpriced
 * token is never "the biggest value" in either direction, it's simply not comparable. */
export function sortBalances<T extends BalanceRow>(rows: readonly T[], key: BalanceSortKey, dir: BalanceSortDir): T[] {
  const sign = dir === "asc" ? 1 : -1;
  const label = (r: T) => r.symbol ?? r.name ?? r.tokenId;
  return [...rows].sort((a, b) => {
    if (key === "asset") return sign * label(a).localeCompare(label(b));
    const val = (r: T) => (key === "holdings" ? Number(r.amount) : key === "price" ? r.price : r.usd);
    const av = val(a);
    const bv = val(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return sign * (av - bv);
  });
}
