/**
 * How the UI shows a transaction's time. Kept pure (no JSX) so it's testable under plain
 * `node --test`.
 *
 * `null` means the chain didn't report when the transaction happened (Solana's RPC returns
 * `blockTime: null` for some very recent signatures — see ADR 0016). It must be shown as unknown.
 * Passing it to `new Date(...)` would not: `new Date(null)` is the Unix epoch, so the UI would
 * quietly print a 1970 date for a real transaction.
 */
export const UNKNOWN_TIME = "time unknown";

export function formatTimestamp(timestamp: string | null): string {
  if (timestamp === null) return UNKNOWN_TIME;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? UNKNOWN_TIME : date.toLocaleString();
}
