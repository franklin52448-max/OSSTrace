/**
 * How the Lookup view presents one transaction's amounts. Kept pure (no JSX) so it's testable
 * under plain `node --test`.
 *
 * A transaction with `status: "failed"` reverted on-chain. Its `valueNative` / `tokenTransfers`
 * describe what it *attempted*, and nothing actually moved (see `TransactionSummary.status` in
 * `@osstrace/core`). So it gets no `+`/`-` sign and no inbound/outbound colour, and is marked
 * FAILED. Without this, the view showed a reverted "-5 ETH" exactly like a real transfer.
 * `status` absent means the adapter didn't check, which isn't a claim of success, but it isn't
 * evidence of failure either, so those render as before.
 */

export type Direction = "in" | "out" | "self";
export type TxStatus = "success" | "failed";

export interface AmountDisplay {
  /** True only when the adapter reported the transaction reverted. */
  failed: boolean;
  sign: "+" | "-" | "";
  tone: "inbound" | "outbound" | "neutral";
}

export function amountDisplay(direction: Direction, status: TxStatus | undefined): AmountDisplay {
  if (status === "failed") return { failed: true, sign: "", tone: "neutral" };
  if (direction === "in") return { failed: false, sign: "+", tone: "inbound" };
  if (direction === "out") return { failed: false, sign: "-", tone: "outbound" };
  return { failed: false, sign: "", tone: "neutral" };
}
