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

/** Where one transaction sits in the chain's own order: newest first means highest (block, txIndex) first. */
export interface HistoryPosition {
  block: number;
  txIndex: number;
}

/**
 * The paging cursor (ADR 0018): "everything strictly older than `(block, txIndex)`". The next page
 * is fetched with Etherscan's own `endblock = block` (inclusive, so the rest of that block isn't
 * skipped), and the rows of that block the caller has already been shown are filtered back out.
 *
 * `nativeSeen`/`tokenSeen` say how many `txlist`/`tokentx` rows in `block` the caller has already
 * been shown. The next fetch asks Etherscan for `limit + seen` rows of each, so those re-fetched,
 * filtered-out rows can't use up the page: at least `limit` unseen rows still come back whenever
 * that many exist. Without this, an address with `limit` or more entries in one block (any busy
 * router) would page into the same block forever.
 */
export interface EthereumCursor extends HistoryPosition {
  nativeSeen: number;
  tokenSeen: number;
}

const CURSOR_FORMAT = /^(\d{1,10}):(\d{1,6}):(\d{1,6}):(\d{1,6})$/;

/** `block:txIndex:nativeSeen:tokenSeen`. Opaque to callers; only this module reads it back. */
export function encodeCursor(cursor: EthereumCursor): string {
  return `${cursor.block}:${cursor.txIndex}:${cursor.nativeSeen}:${cursor.tokenSeen}`;
}

/** The cursor, or `null` if `raw` isn't one `encodeCursor` could have produced. */
export function decodeCursor(raw: string): EthereumCursor | null {
  const match = CURSOR_FORMAT.exec(raw);
  if (!match) return null;
  return { block: Number(match[1]), txIndex: Number(match[2]), nativeSeen: Number(match[3]), tokenSeen: Number(match[4]) };
}

function lowestBlock(rows: readonly { blockNumber: string }[]): number {
  return rows.reduce((min, row) => Math.min(min, Number(row.blockNumber)), Number.POSITIVE_INFINITY);
}

/** True when `(block, txIndex)` is strictly older than `cursor` — i.e. not yet shown to the caller. */
function olderThan(block: number, txIndex: number, cursor: HistoryPosition | undefined): boolean {
  return !cursor || block < cursor.block || (block === cursor.block && txIndex < cursor.txIndex);
}

/**
 * How many rows to ask Etherscan for, per list, for a page of `limit` after `before` (see
 * `EthereumCursor`). The adapter fetches with these as `offset`; `mergeHistoryPage` uses the same
 * numbers to tell whether a list came back full.
 */
export function requestedRows(limit: number, before: EthereumCursor | undefined): { native: number; token: number } {
  return { native: limit + (before?.nativeSeen ?? 0), token: limit + (before?.tokenSeen ?? 0) };
}

export interface MergedPage {
  transactions: TransactionSummary[];
  /** Present when older history may exist; pass it back as `before` for the next page. */
  nextCursor?: EthereumCursor;
}

/**
 * Merges one page of `txlist` and one page of `tokentx` (both fetched newest-first, `offset` =
 * `requestedRows(limit, before)`, and `endblock = before.block` when paging) into at most `limit`
 * transactions, newest first, one entry per hash:
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
 * are dropped rather than shown with silently missing native/token data. They aren't lost: the
 * `nextCursor` sits above them, so the next page starts with them. Known edge: a transaction *in*
 * the cut-off block of a full `tokentx` page can still have a further transfer on the next page,
 * and paging treats that transaction as already shown.
 *
 * Paging: rows at or after `before`'s position were on an earlier page and are filtered out.
 */
export function mergeHistoryPage(
  nativeRows: readonly EtherscanTx[],
  tokenRows: readonly EtherscanTokenTx[],
  address: string,
  limit: number,
  before?: EthereumCursor,
): MergedPage {
  const requested = requestedRows(limit, before);
  const nativeFull = nativeRows.length > 0 && nativeRows.length >= requested.native;
  const tokenFull = tokenRows.length > 0 && tokenRows.length >= requested.token;
  let cutoffBlock = 0;
  if (nativeFull) cutoffBlock = Math.max(cutoffBlock, lowestBlock(nativeRows));
  if (tokenFull) cutoffBlock = Math.max(cutoffBlock, lowestBlock(tokenRows));

  const unseenNative = nativeRows.filter((row) => olderThan(Number(row.blockNumber), Number(row.transactionIndex), before));
  const unseenTokens = tokenRows.filter((row) => olderThan(Number(row.blockNumber), Number(row.transactionIndex), before));

  const entries = new Map<string, MergedEntry>();
  for (const row of unseenNative) {
    entries.set(row.hash, {
      block: Number(row.blockNumber),
      txIndex: Number(row.transactionIndex),
      summary: summarizeNativeTx(row, address),
    });
  }
  for (const row of unseenTokens) {
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

  const ordered = [...entries.values()]
    .filter((entry) => entry.block >= cutoffBlock)
    .sort((a, b) => b.block - a.block || b.txIndex - a.txIndex);
  const page = ordered.slice(0, limit);
  const transactions = page.map((entry) => entry.summary);

  const mayHaveMore = nativeFull || tokenFull || ordered.length > limit;
  const last = page.at(-1);
  if (!mayHaveMore || !last) return { transactions };

  // Rows in the last entry's block, at or after it, that the caller has now been shown: this
  // page's own, plus (when this page ended in the same block the previous one did) the earlier ones.
  const atOrAfterLast = (row: { blockNumber: string; transactionIndex: string }): boolean =>
    Number(row.blockNumber) === last.block && Number(row.transactionIndex) >= last.txIndex;
  const carried = before && before.block === last.block ? before : undefined;
  return {
    transactions,
    nextCursor: {
      block: last.block,
      txIndex: last.txIndex,
      nativeSeen: (carried?.nativeSeen ?? 0) + unseenNative.filter(atOrAfterLast).length,
      tokenSeen: (carried?.tokenSeen ?? 0) + unseenTokens.filter(atOrAfterLast).length,
    },
  };
}

/** `mergeHistoryPage` for the most recent page, transactions only. */
export function mergeHistory(
  nativeRows: readonly EtherscanTx[],
  tokenRows: readonly EtherscanTokenTx[],
  address: string,
  limit: number,
): TransactionSummary[] {
  return mergeHistoryPage(nativeRows, tokenRows, address, limit).transactions;
}
