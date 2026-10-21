import { test } from "node:test";
import assert from "node:assert/strict";
import { SolanaAdapter } from "../src/adapter.ts";
import { liveHistoryOrSkip, RPC_URL, rpcReachable } from "./liveRpc.ts";

// Real network test against a public RPC — no mocking. Skips (not fails) if unreachable or
// rate-limited, same pattern as this workspace's Postgres conformance suites.
// The native System Program's own address — guaranteed to exist with a real balance and a huge
// real transaction history on any live cluster, so this test never depends on one specific
// wallet still being active.
const KNOWN_ADDRESS = "11111111111111111111111111111111";

test("getBalance returns a well-formed, real balance from a public RPC", async (t) => {
  if (!(await rpcReachable())) {
    t.skip(`${RPC_URL} unreachable from this environment — skipping live network test`);
    return;
  }
  const adapter = new SolanaAdapter({ rpcUrl: RPC_URL });
  const balance = await adapter.getBalance(KNOWN_ADDRESS);
  assert.equal(balance.chain, "solana");
  assert.equal(balance.address, KNOWN_ADDRESS);
  assert.equal(balance.native.symbol, "SOL");
  assert.equal(balance.native.decimals, 9);
  assert.match(balance.native.amount, /^\d+(\.\d+)?$/);
});

test("getRecentTransactions returns real, well-formed transactions with no API key needed", async (t) => {
  if (!(await rpcReachable())) {
    t.skip(`${RPC_URL} unreachable from this environment — skipping live network test`);
    return;
  }
  const adapter = new SolanaAdapter({ rpcUrl: RPC_URL });
  const result = await liveHistoryOrSkip(t, () => adapter.getRecentTransactions(KNOWN_ADDRESS, 2));
  if (!result) return;
  assert.equal(result.available, true);
  if (result.available) {
    assert.ok(result.transactions.length > 0, "expected at least one real transaction");
    for (const tx of result.transactions) {
      assert.equal(tx.chain, "solana");
      assert.match(tx.hash, /^[1-9A-HJ-NP-Za-km-z]+$/, "hash should be base58");
      assert.doesNotThrow(() => new Date(tx.timestamp).toISOString());
      assert.match(tx.valueNative, /^\d+(\.\d+)?$/);
      assert.ok(["in", "out", "self"].includes(tx.direction));
    }
  }
});

test("getRecentTransactions reports an RPC it can't reach as unavailable, with a reason, instead of throwing", async () => {
  // A real connection attempt to a local port nothing listens on (the discard port) — refused
  // immediately by the OS, no network or mocking involved.
  const adapter = new SolanaAdapter({ rpcUrl: "http://127.0.0.1:9" });
  const result = await adapter.getRecentTransactions(KNOWN_ADDRESS, 2);
  assert.equal(result.available, false);
  if (!result.available) {
    assert.match(result.reason, /^Solana RPC: /);
  }
});
