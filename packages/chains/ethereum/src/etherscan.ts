import type { TokenTransfer, TransactionSummary, TransferDirection } from "@osstrace/core";
import { formatUnits } from "./units.ts";

/**
 * Pure decoding of Etherscan v2 `txlist` / `tokentx` rows into the core TransactionSummary shape.
 * No network calls live here, so every rule below is unit-testable against real recorded rows.
 *
 * Field names are the ones Etherscan documents (docs.etherscan.io/api-reference/endpoint/txlist
 * and .../tokentx), restricted to what this adapter reads. Every value arrives as a string.
 */

/** One `txlist` row ("normal" transaction sent from or to the address). */
export interface EtherscanTx {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  transactionIndex: string;
  from: string;
  to: string;
  value: string;
  isError: string;
}

/**
 * One `tokentx` row: a single ERC-20 `Transfer` event involving the address. Note `from`/`to`
 * here are the *token transfer's* from/to (the Transfer event's indexed topics), not the
 * transaction's sender/recipient — verified against a real receipt (see tests/fixtures), even
 * though Etherscan's own field description for `from` says "address that sent the transaction".
 */
export interface EtherscanTokenTx {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  transactionIndex: string;
  from: string;
  to: string;
  contractAddress: string;
  value: string;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimal: string;
}

const UNSIGNED_INTEGER = /^\d+$/;
/** ERC-20's `decimals()` returns a uint8. */
const MAX_ERC20_DECIMALS = 255;

function directionFor(from: string, to: string | null, address: string): TransferDirection {
  const fromSelf = from.toLowerCase() === address;
  const toSelf = (to ?? "").toLowerCase() === address;
  if (fromSelf && toSelf) return "self";
  if (fromSelf) return "out";
  return "in";
}

function isoTimestamp(unixSeconds: string): string {
  return new Date(Number(unixSeconds) * 1000).toISOString();
}

/** A `txlist` row as a TransactionSummary — the native-ETH view, unchanged from before tokentx existed. */
export function summarizeNativeTx(tx: EtherscanTx, address: string): TransactionSummary {
  const lower = address.toLowerCase();
  return {
    chain: "ethereum",
    hash: tx.hash,
    timestamp: isoTimestamp(tx.timeStamp),
    from: tx.from,
    to: tx.to || null,
    valueNative: formatUnits(BigInt(tx.value), 18),
    direction: directionFor(tx.from, tx.to || null, lower),
    // Etherscan's own `isError`: "1" means the transaction reverted. Anything else means it didn't.
    status: tx.isError === "1" ? "failed" : "success",
  };
}

/**
 * A `tokentx` row as a TokenTransfer. Decimals come from the row's own `tokenDecimal` (Etherscan
 * reads it from the token contract); if that's missing, not an integer, or outside ERC-20's uint8
 * range, `decimals`/`amount` are `null` and only the exact `rawAmount` is reported — never a
 * guessed 18.
 *
 * The uint8 bound isn't pedantry: tokenDecimal is whatever the contract returned, anyone can
 * deploy a token and airdrop it to any address, and scaling by 10^(huge) blocks the event loop for
 * minutes. A value no standard token can have is "unknown", not something to compute with.
 */
export function decodeTokenTransfer(row: EtherscanTokenTx, address: string): TokenTransfer {
  const lower = address.toLowerCase();
  const decimals =
    UNSIGNED_INTEGER.test(row.tokenDecimal) && Number(row.tokenDecimal) <= MAX_ERC20_DECIMALS ? Number(row.tokenDecimal) : null;
  const rawValid = UNSIGNED_INTEGER.test(row.value);
  const to = row.to || null;
  return {
    token: row.contractAddress || null,
    symbol: row.tokenSymbol || null,
    name: row.tokenName || null,
    decimals,
    rawAmount: row.value,
    amount: decimals !== null && rawValid ? formatUnits(BigInt(row.value), decimals) : null,
    from: row.from || null,
    to,
    direction: directionFor(row.from, to, lower),
  };
}

interface MergedEntry {
  block: number;
  txIndex: number;
  summary: TransactionSummary;
}

function lowestBlock(rows: readonly { blockNumber: string }[]): number {
  return rows.reduce((min, row) => Math.min(min, Number(row.blockNumber)), Number.POSITIVE_INFINITY);
}

/**
 * Merges one page of `txlist` and one page of `tokentx` (both fetched newest-first with
 * `offset = limit`) into at most `limit` transactions, newest first, one entry per hash:
 *
 * - A hash in both lists → its native summary, with `tokenTransfers` attached.
 * - A hash only in `txlist` → its native summary, exactly as before (no `tokenTransfers` key).
 * - A hash only in `tokentx` (tokens moved to/from this address in a transaction it neither sent
 *   nor was the `to` of — e.g. a plain incoming ERC-20 transfer) → `valueNative: "0"`, and
 *   `from`/`to`/`direction` mirror the first token transfer involving the address, since
 *   `tokentx` doesn't carry the transaction's own sender.
 *
 * Completeness: if a page came back full, anything older than that page's oldest block might be
 * missing from it (it'd be on page 2), so entries older than the newer of the two cut-off blocks
 * are dropped rather than shown with silently missing native/token data. Known edge: a
 * transaction *in* the cut-off block of a full `tokentx` page can still have a further transfer
 * on the next page.
 */
export function mergeHistory(
  nativeRows: readonly EtherscanTx[],
  tokenRows: readonly EtherscanTokenTx[],
  address: string,
  limit: number,
): TransactionSummary[] {
  let cutoffBlock = 0;
  if (nativeRows.length > 0 && nativeRows.length >= limit) cutoffBlock = Math.max(cutoffBlock, lowestBlock(nativeRows));
  if (tokenRows.length > 0 && tokenRows.length >= limit) cutoffBlock = Math.max(cutoffBlock, lowestBlock(tokenRows));

  const entries = new Map<string, MergedEntry>();
  for (const row of nativeRows) {
    entries.set(row.hash, {
      block: Number(row.blockNumber),
      txIndex: Number(row.transactionIndex),
      summary: summarizeNativeTx(row, address),
    });
  }
  for (const row of tokenRows) {
    const transfer = decodeTokenTransfer(row, address);
    const existing = entries.get(row.hash);
    if (existing) {
      (existing.summary.tokenTransfers ??= []).push(transfer);
      continue;
    }
    entries.set(row.hash, {
      block: Number(row.blockNumber),
      txIndex: Number(row.transactionIndex),
      summary: {
        chain: "ethereum",
        hash: row.hash,
        timestamp: isoTimestamp(row.timeStamp),
        // tokentx always has a from; `to` falls back to null only if Etherscan sent it empty.
        from: transfer.from ?? row.from,
        to: transfer.to,
        valueNative: "0",
        direction: transfer.direction,
        tokenTransfers: [transfer],
        // tokentx rows come from real Transfer events, which only ever fire on a successful tx.
        status: "success",
      },
    });
  }

  return [...entries.values()]
    .filter((entry) => entry.block >= cutoffBlock)
    .sort((a, b) => b.block - a.block || b.txIndex - a.txIndex)
    .slice(0, limit)
    .map((entry) => entry.summary);
}
