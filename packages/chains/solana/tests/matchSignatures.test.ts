import { test } from "node:test";
import assert from "node:assert/strict";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { matchTransactionsToSignatures } from "../src/adapter.ts";

// Only the field the matcher reads; the rest of a parsed transaction is irrelevant here.
function tx(signature: string): ParsedTransactionWithMeta {
  return { transaction: { signatures: [signature] } } as unknown as ParsedTransactionWithMeta;
}

test("matchTransactionsToSignatures pairs by signature when the RPC batch comes back out of order", () => {
  // Same shape as a real mainnet response observed 2026-10-21: two items swapped.
  const matched = matchTransactionsToSignatures(["a", "b", "c", "d"], [tx("a"), tx("c"), tx("b"), tx("d")]);
  assert.deepEqual(
    matched.map((t) => t?.transaction.signatures[0] ?? null),
    ["a", "b", "c", "d"],
  );
});

test("matchTransactionsToSignatures returns null for a signature the RPC returned no transaction for", () => {
  const matched = matchTransactionsToSignatures(["a", "b"], [null, tx("a")]);
  assert.deepEqual(
    matched.map((t) => t?.transaction.signatures[0] ?? null),
    ["a", null],
  );
});
