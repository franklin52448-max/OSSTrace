import type { TransactionSummary } from "@osstrace/core";

export interface TransactionDiff {
  /** Transactions in `current` judged genuinely new since `previous`, oldest first. */
  newTransactions: TransactionSummary[];
  /**
   * True when the whole current window is new (no overlap with the previous fetch) and the window
   * is full: more transactions may have happened since the last fetch than one window can hold,
   * so the ones pushed are not necessarily all of them.
   */
  windowOverflow: boolean;
}

function timeOf(tx: TransactionSummary): number {
  return Date.parse(tx.timestamp);
}

/**
 * "New since the last fetch", decided by diffing transaction hashes between two consecutive
 * fetches of the same address at the same limit. See ADR 0013 for the full reasoning.
 *
 * - `previous === null` means there is no baseline yet (first time the indexer has fetched this
 *   address in its current run). Nothing is reported: with no earlier fetch to compare against,
 *   there's no way to tell a transaction that just happened from one that's months old.
 * - A hash absent from `previous` is new — with one guard. If the previous fetch filled the whole
 *   window (`previous.length >= limit`), the window only covered transactions back to its oldest
 *   entry. A hash older than that could just be an old transaction at the bottom edge of the
 *   window that the previous fetch happened not to include, not a new one, so it isn't reported.
 *   If the previous window was *not* full, it held the address's entire history, so any unseen
 *   hash is new regardless of its timestamp.
 */
export function diffTransactions(
  previous: readonly TransactionSummary[] | null,
  current: readonly TransactionSummary[],
  limit: number,
): TransactionDiff {
  if (previous === null) return { newTransactions: [], windowOverflow: false };

  const previousHashes = new Set(previous.map((tx) => tx.hash));
  let fresh = current.filter((tx) => !previousHashes.has(tx.hash));

  if (previous.length >= limit && previous.length > 0) {
    const oldestPrevious = Math.min(...previous.map(timeOf));
    if (Number.isFinite(oldestPrevious)) {
      // NaN timestamps fail `>=` and are dropped: an undatable transaction can't be shown to be newer.
      fresh = fresh.filter((tx) => timeOf(tx) >= oldestPrevious);
    }
  }

  const windowOverflow =
    previous.length > 0 && current.length >= limit && current.every((tx) => !previousHashes.has(tx.hash));

  // Oldest first, so a client applying events in order ends up with the same order the API returns.
  const newTransactions = [...fresh].sort((a, b) => {
    const delta = timeOf(a) - timeOf(b);
    return Number.isNaN(delta) ? 0 : delta;
  });
  return { newTransactions, windowOverflow };
}
