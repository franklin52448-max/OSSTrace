import { Connection, PublicKey, type ConfirmedSignatureInfo, type ParsedInstruction, type ParsedTransactionWithMeta } from "@solana/web3.js";
import type { Balance, ChainAdapter, TransactionSummary, TransactionsResult } from "@opentrace/core";
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
 */
function summarizeTransaction(
  sigInfo: ConfirmedSignatureInfo,
  tx: ParsedTransactionWithMeta | null,
  address: string,
): TransactionSummary {
  const timestamp = sigInfo.blockTime ? new Date(sigInfo.blockTime * 1000).toISOString() : new Date(0).toISOString();
  if (!tx || !tx.meta) {
    return { chain: "solana", hash: sigInfo.signature, timestamp, from: "unknown", to: null, valueNative: "0", direction: "self" };
  }

  // Primary path: directly decode a native SOL transfer instruction (top-level or inner)
  // involving this address — gives a real, specific counterparty, not just a balance delta.
  const allInstructions = [
    ...tx.transaction.message.instructions,
    ...(tx.meta.innerInstructions?.flatMap((group) => group.instructions) ?? []),
  ];
  const transfer = allInstructions.find(
    (ix) => isSystemTransfer(ix) && (ix.parsed.info.source === address || ix.parsed.info.destination === address),
  );
  if (transfer && isSystemTransfer(transfer)) {
    const { source, destination, lamports } = transfer.parsed.info;
    return {
      chain: "solana",
      hash: sigInfo.signature,
      timestamp,
      from: source,
      to: destination,
      valueNative: lamportsToSol(lamports),
      direction: source === destination ? "self" : source === address ? "out" : "in",
    };
  }

  // Fallback: not a plain native transfer we can decode (token transfer, program interaction,
  // etc.) — report this address's own net balance change honestly, without inventing a
  // counterparty we didn't actually resolve.
  const accountIndex = tx.transaction.message.accountKeys.findIndex((key) => key.pubkey.toBase58() === address);
  const pre = accountIndex >= 0 ? (tx.meta.preBalances[accountIndex] ?? 0) : 0;
  const post = accountIndex >= 0 ? (tx.meta.postBalances[accountIndex] ?? 0) : 0;
  const delta = post - pre;
  return {
    chain: "solana",
    hash: sigInfo.signature,
    timestamp,
    from: delta < 0 ? address : "unresolved (non-transfer instruction)",
    to: delta > 0 ? address : delta < 0 ? null : address,
    valueNative: lamportsToSol(Math.abs(delta)),
    direction: delta > 0 ? "in" : delta < 0 ? "out" : "self",
  };
}

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

  async getRecentTransactions(address: string, limit: number): Promise<TransactionsResult> {
    const pubkey = new PublicKey(address);
    const signatures = await this.#connection.getSignaturesForAddress(pubkey, { limit });
    if (signatures.length === 0) {
      return { available: true, transactions: [] };
    }

    // Batched: one JSON-RPC batch request for every signature, instead of the N sequential
    // getParsedTransaction round trips this used to make (web3.js's getParsedTransactions
    // builds a single _rpcBatchRequest under the hood — confirmed by reading its source before
    // relying on it). This is the fix for the N+1 pattern documented in SCALING-AND-COSTS.md.
    const parsedTxs = await this.#connection.getParsedTransactions(
      signatures.map((s) => s.signature),
      // Generously high on purpose: Solana's versioned-transaction scheme keeps adding new
      // version numbers over time, and getParsedTransactions throws for the *entire batch* if
      // any single transaction exceeds this — a live test caught a real version-1 transaction
      // that `maxSupportedTransactionVersion: 0` rejected outright.
      { maxSupportedTransactionVersion: 255 },
    );

    const transactions = signatures.map((sigInfo, i) => summarizeTransaction(sigInfo, parsedTxs[i] ?? null, address));
    return { available: true, transactions };
  }
}
