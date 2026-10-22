import { Connection, PublicKey, type ConfirmedSignatureInfo, type ParsedInstruction, type ParsedTransactionWithMeta } from "@solana/web3.js";
import type { Balance, ChainAdapter, TransactionsPageOptions, TransactionSummary, TransactionsResult } from "@osstrace/core";
import { decodeSplTransfers } from "./splToken.ts";
import { lamportsToSol } from "./units.ts";

export interface SolanaAdapterConfig {
  /** A standard Solana RPC endpoint. No API key required. */
  rpcUrl: string;
}

function isSystemTransfer(
  ix: unknown,
): ix is ParsedInstruction & { parsed: { type: "transfer"; info: { source: string; destination: string; lamports: number } } } {
  const instruction = ix as ParsedInstruction;
  return (
    instruction.program === "system" &&
    typeof instruction.parsed === "object" &&
    instruction.parsed !== null &&
    (instruction.parsed as { type?: string }).type === "transfer"
  );
}

/**
 * Turns one parsed transaction (or its absence) into a TransactionSummary for `address`.
 * Pulled out of getRecentTransactions so the batch-fetch path (one RPC round trip for every
 * signature, see below) and any future retry/backfill logic can share the exact same per-tx
 * decoding — this is pure and has no RPC calls of its own.
 *
 * The top-level fields are always the native-SOL view (a decoded system transfer, else this
 * address's own lamport balance delta). Decoded SPL Token transfers involving the address are
 * attached separately as `tokenTransfers` — absent when there are none.
 */
export function summarizeTransaction(
  sigInfo: Pick<ConfirmedSignatureInfo, "signature" | "blockTime"> & Partial<Pick<ConfirmedSignatureInfo, "err">>,
  tx: ParsedTransactionWithMeta | null,
  address: string,
): TransactionSummary {
  const timestamp = sigInfo.blockTime ? new Date(sigInfo.blockTime * 1000).toISOString() : new Date(0).toISOString();
  if (!tx || !tx.meta) {
    // The details didn't come back, so nothing about what moved is known. But
    // getSignaturesForAddress already said whether the transaction failed (`err`), and dropping
    // that would let a reverted transaction look merely unchecked.
    const status: TransactionSummary["status"] | undefined =
      sigInfo.err === undefined ? undefined : sigInfo.err === null ? "success" : "failed";
    return {
      chain: "solana",
      hash: sigInfo.signature,
      timestamp,
      from: "unknown",
      to: null,
      valueNative: "0",
      direction: "self",
      ...(status ? { status } : {}),
    };
  }
  const summary = summarizeNative(sigInfo.signature, timestamp, tx, address);
  const tokenTransfers = decodeSplTransfers(tx, address);
  // tx.meta.err is non-null for any transaction that reverted — whatever the native/token decode
  // above found is what it *attempted*, not what actually moved (a failed tx still touches
  // accounts and can "decode" as a transfer instruction that never took effect).
  const status: TransactionSummary["status"] = tx.meta.err === null ? "success" : "failed";
  return { ...summary, ...(tokenTransfers.length > 0 ? { tokenTransfers } : {}), status };
}

function summarizeNative(signature: string, timestamp: string, tx: ParsedTransactionWithMeta, address: string): TransactionSummary {
  // Primary path: directly decode a native SOL transfer instruction (top-level or inner)
  // involving this address — gives a real, specific counterparty, not just a balance delta.
  const allInstructions = [
    ...tx.transaction.message.instructions,
    ...(tx.meta?.innerInstructions?.flatMap((group) => group.instructions) ?? []),
  ];
  const transfer = allInstructions.find(
    (ix) => isSystemTransfer(ix) && (ix.parsed.info.source === address || ix.parsed.info.destination === address),
  );
  if (transfer && isSystemTransfer(transfer)) {
    const { source, destination, lamports } = transfer.parsed.info;
    return {
      chain: "solana",
      hash: signature,
      timestamp,
      from: source,
      to: destination,
      valueNative: lamportsToSol(lamports),
      direction: source === destination ? "self" : source === address ? "out" : "in",
    };
  }

  // Fallback: not a plain native transfer we can decode (a token transfer, a program interaction,
  // etc.) — report this address's own net native balance change honestly, without inventing a
  // counterparty we didn't actually resolve. Any SPL transfers are reported in tokenTransfers.
  // (`toString()`, not `toBase58()`: identical for a web3.js PublicKey, and also works on the raw
  // JSON-RPC shape, where pubkey is already a base58 string.)
  const accountIndex = tx.transaction.message.accountKeys.findIndex((key) => key.pubkey.toString() === address);
  const meta = tx.meta;
  const pre = accountIndex >= 0 && meta ? (meta.preBalances[accountIndex] ?? 0) : 0;
  const post = accountIndex >= 0 && meta ? (meta.postBalances[accountIndex] ?? 0) : 0;
  const delta = post - pre;
  return {
    chain: "solana",
    hash: signature,
    timestamp,
    from: delta < 0 ? address : "unresolved (non-transfer instruction)",
    to: delta > 0 ? address : delta < 0 ? null : address,
    valueNative: lamportsToSol(Math.abs(delta)),
    direction: delta > 0 ? "in" : delta < 0 ? "out" : "self",
  };
}

/**
 * Pairs each requested signature with its parsed transaction BY SIGNATURE, not by array index.
 * A JSON-RPC batch response may legally come back in any order, and web3.js's
 * getParsedTransactions returns it in whatever order the server sent it — confirmed against the
 * real public mainnet RPC (2026-10-21), which returned 2 of 5 transactions swapped. Pairing by
 * index silently attached one transaction's hash/timestamp to another transaction's transfer.
 */
export function matchTransactionsToSignatures(
  signatures: readonly string[],
  parsedTxs: readonly (ParsedTransactionWithMeta | null)[],
): (ParsedTransactionWithMeta | null)[] {
  const bySignature = new Map<string, ParsedTransactionWithMeta>();
  for (const tx of parsedTxs) {
    const signature = tx?.transaction.signatures[0];
    if (tx && signature) bySignature.set(signature, tx);
  }
  return signatures.map((signature) => bySignature.get(signature) ?? null);
}

/** A base58 transaction signature (64 bytes, so at most 88 characters). Anything else can't be a `before` cursor. */
const SIGNATURE_FORMAT = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;

export class SolanaAdapter implements ChainAdapter {
  readonly chain = "solana" as const;
  readonly #connection: Connection;

  constructor(config: SolanaAdapterConfig) {
    this.#connection = new Connection(config.rpcUrl, "confirmed");
  }

  async getBalance(address: string): Promise<Balance> {
    const lamports = await this.#connection.getBalance(new PublicKey(address));
    return {
      chain: "solana",
      address,
      native: { symbol: "SOL", amount: lamportsToSol(lamports), decimals: 9 },
      asOf: new Date().toISOString(),
    };
  }

  /**
   * Paging (ADR 0018) is Solana's own cursor: `getSignaturesForAddress`'s `before` takes a
   * transaction signature and returns only signatures older than it (exclusive). So `nextCursor`
   * is the oldest signature on this page, set whenever the page came back full (`limit`
   * signatures, so there may be more). A shorter page is the end of the history.
   */
  async getRecentTransactions(address: string, limit: number, options: TransactionsPageOptions = {}): Promise<TransactionsResult> {
    if (options.before !== undefined && !SIGNATURE_FORMAT.test(options.before)) {
      return {
        available: false,
        reason: "invalid `before` cursor for solana — pass the nextCursor (a transaction signature) from a previous page unchanged",
      };
    }
    const pubkey = new PublicKey(address);
    let signatures: ConfirmedSignatureInfo[];
    let parsedTxs: (ParsedTransactionWithMeta | null)[];
    try {
      signatures = await this.#connection.getSignaturesForAddress(pubkey, {
        limit,
        ...(options.before !== undefined ? { before: options.before } : {}),
      });
      if (signatures.length === 0) {
        return { available: true, transactions: [] };
      }

      // Batched: one JSON-RPC batch request for every signature, instead of the N sequential
      // getParsedTransaction round trips this used to make (web3.js's getParsedTransactions
      // builds a single _rpcBatchRequest under the hood — confirmed by reading its source before
      // relying on it). This is the fix for the N+1 pattern documented in SCALING-AND-COSTS.md.
      parsedTxs = await this.#connection.getParsedTransactions(
        signatures.map((s) => s.signature),
        // Generously high on purpose: Solana's versioned-transaction scheme keeps adding new
        // version numbers over time, and getParsedTransactions throws for the *entire batch* if
        // any single transaction exceeds this — a live test caught a real version-1 transaction
        // that `maxSupportedTransactionVersion: 0` rejected outright.
        { maxSupportedTransactionVersion: 255 },
      );
    } catch (cause) {
      // The ChainAdapter contract: "couldn't fetch" is a typed result, not a throw. In practice
      // this is mostly the public RPC rate-limiting the batch (HTTP 429, after web3.js's own
      // retries), or rejecting its size — not something a caller should see as a crash.
      return { available: false, reason: `Solana RPC: ${cause instanceof Error ? cause.message : String(cause)}` };
    }

    const matched = matchTransactionsToSignatures(
      signatures.map((s) => s.signature),
      parsedTxs,
    );
    const transactions = signatures.map((sigInfo, i) => summarizeTransaction(sigInfo, matched[i] ?? null, address));
    const oldest = signatures.at(-1)?.signature;
    return { available: true, transactions, ...(signatures.length >= limit && oldest ? { nextCursor: oldest } : {}) };
  }
}
