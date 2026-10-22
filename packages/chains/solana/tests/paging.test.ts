import { test } from "node:test";
import assert from "node:assert/strict";
import { Connection, PublicKey } from "@solana/web3.js";
import { SolanaAdapter } from "../src/adapter.ts";
import { liveHistoryOrSkip, liveOrSkip, RPC_URL, rpcReachable } from "./liveRpc.ts";

// Cursor paging (ADR 0018): Solana's own `getSignaturesForAddress` `before` cursor.

// The System Program: a huge real history on any live cluster, so there's always a page 2.
const BUSY_ADDRESS = "11111111111111111111111111111111";

test("live: page 2 via `before` is exactly the next signatures after page 1, from the real RPC", async (t) => {
  if (!(await rpcReachable())) {
    t.skip(`${RPC_URL} unreachable from this environment — skipping live network test`);
    return;
  }
  const adapter = new SolanaAdapter({ rpcUrl: RPC_URL });
  const first = await liveHistoryOrSkip(t, () => adapter.getRecentTransactions(BUSY_ADDRESS, 3));
  if (!first) return;
  assert.equal(first.available, true, first.available ? "" : first.reason);
  if (!first.available) return;
  assert.equal(first.transactions.length, 3);
  assert.equal(first.nextCursor, first.transactions[2]?.hash, "the cursor is page 1's oldest signature");

  const second = await liveHistoryOrSkip(t, () => adapter.getRecentTransactions(BUSY_ADDRESS, 3, { before: first.nextCursor! }));
  if (!second) return;
  assert.equal(second.available, true, second.available ? "" : second.reason);
  if (!second.available) return;

  // The independent check, anchored on page 1's newest signature so new activity on this very
  // busy address can't shift it: the RPC's own next 5 signatures after that one must be page 1's
  // other two followed by all of page 2 — the next set, with no overlap and no gap.
  const anchored = await liveOrSkip(t, () =>
    new Connection(RPC_URL, "confirmed").getSignaturesForAddress(new PublicKey(BUSY_ADDRESS), {
      limit: 5,
      before: first.transactions[0]!.hash,
    }),
  );
  if (!anchored) return;
  const firstHashes = first.transactions.map((tx) => tx.hash);
  const secondHashes = second.transactions.map((tx) => tx.hash);
  assert.equal(secondHashes.length, 3);
  assert.equal(secondHashes.filter((h) => firstHashes.includes(h)).length, 0, "page 2 must not overlap page 1");
  assert.deepEqual(
    anchored.map((s) => s.signature),
    [...firstHashes.slice(1), ...secondHashes],
  );
});

test("a cursor that can't be a signature is reported as unavailable, without calling the RPC", async () => {
  // Port 9 (discard): any RPC call would fail with "Solana RPC: ..." — this must fail earlier.
  const adapter = new SolanaAdapter({ rpcUrl: "http://127.0.0.1:9" });
  for (const before of ["not a signature", "0OIl", "x".repeat(200)]) {
    const result = await adapter.getRecentTransactions(BUSY_ADDRESS, 3, { before });
    assert.equal(result.available, false);
    if (!result.available) assert.match(result.reason, /invalid `before` cursor for solana/);
  }
});
