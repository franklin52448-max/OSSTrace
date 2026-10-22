import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileLabelStore, type Balance, type ChainAdapter, type ChainId, type TransactionSummary, type TransactionsResult } from "@osstrace/core";
import type { TokenTransfer } from "@osstrace/core";
import { buildTraceGraph, buildTracePath, clampTraceOptions, tracePath, traceGraph, type TraceOptions } from "../src/trace.ts";

/** A real, concrete ChainAdapter stand-in: each address has its own fixed transaction list, or none at all. */
class MapChainAdapter implements ChainAdapter {
  readonly chain: ChainId;
  readonly #byAddress: Map<string, TransactionsResult>;
  calls: string[] = [];
  constructor(chain: ChainId, byAddress: Map<string, TransactionsResult>) {
    this.chain = chain;
    this.#byAddress = byAddress;
  }
  async getBalance(address: string): Promise<Balance> {
    return { chain: this.chain, address, native: { symbol: "ETH", amount: "0", decimals: 18 }, asOf: "2026-01-01T00:00:00Z" };
  }
  async getRecentTransactions(address: string, _limit: number): Promise<TransactionsResult> {
    this.calls.push(address);
    return this.#byAddress.get(address) ?? { available: false, reason: "no fixture for this address" };
  }
}

const CENTER = "0x1111111111111111111111111111111111111111";
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = `0x${"c".repeat(40)}`;
const D = "0xdddddddddddddddddddddddddddddddddddddddd";
const E = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const TARGET = "0xffffffffffffffffffffffffffffffffffffffff";

function ethTx(
  hash: string,
  from: string,
  to: string,
  valueNative: string,
  direction: TransactionSummary["direction"],
  timestamp: string,
  tokenTransfers?: TokenTransfer[],
): TransactionSummary {
  return { chain: "ethereum", hash, timestamp, from, to, valueNative, direction, ...(tokenTransfers ? { tokenTransfers } : {}) };
}

function usdc(direction: TokenTransfer["direction"], from: string | null, to: string | null, amount: string): TokenTransfer {
  return {
    token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    rawAmount: `${Number(amount) * 1_000_000}`,
    amount,
    from,
    to,
    direction,
  };
}

const DEFAULT_OPTS: TraceOptions = { maxHops: 2, breadth: 5, txLimitPerNode: 10, maxAdapterCalls: 40 };

test("clampTraceOptions clamps every field into its documented range", () => {
  assert.deepEqual(clampTraceOptions({ maxHops: 99, breadth: 0, txLimitPerNode: -5, maxAdapterCalls: 1000 }), {
    maxHops: 3,
    breadth: 1,
    txLimitPerNode: 1,
    maxAdapterCalls: 100,
  });
  assert.deepEqual(clampTraceOptions({ maxHops: Number.NaN }), { maxHops: 2, breadth: 5, txLimitPerNode: 10, maxAdapterCalls: 40 });
  assert.deepEqual(clampTraceOptions({}), { maxHops: 2, breadth: 5, txLimitPerNode: 10, maxAdapterCalls: 40 });
});

test("traceGraph expands hop-by-hop, keeps every real edge, but only recurses into the breadth most-recent neighbors", async () => {
  const adapter = new MapChainAdapter(
    "ethereum",
    new Map([
      [
        CENTER,
        {
          available: true,
          transactions: [
            ethTx("h-a", CENTER, A, "1", "out", "2026-01-05T00:00:00Z"),
            ethTx("h-b", CENTER, B, "1", "out", "2026-01-04T00:00:00Z"),
            ethTx("h-c", CENTER, C, "1", "out", "2026-01-03T00:00:00Z"),
          ],
        },
      ],
      [A, { available: true, transactions: [ethTx("h-d", A, D, "1", "out", "2026-01-06T00:00:00Z")] }],
      [B, { available: true, transactions: [ethTx("h-e", B, E, "1", "out", "2026-01-02T00:00:00Z")] }],
    ]),
  );

  const result = await traceGraph({ chain: "ethereum", value: CENTER }, adapter, { ...DEFAULT_OPTS, breadth: 2 });

  // Every real edge is kept, including C's (breadth-capped) and the ones found past A/B.
  assert.deepEqual(
    result.edges.map((e) => e.id).sort(),
    ["h-a", "h-b", "h-c", "h-d", "h-e"].sort(),
  );
  // Only A and B (most recent 2 of CENTER's 3 neighbors) were actually expanded.
  assert.deepEqual(result.expandedIds.sort(), [A, B, CENTER].sort());
  // C never got expanded (breadth-capped); D and E were discovered but not expanded (depth-capped at maxHops=2).
  const frontierByReason = new Map(result.frontier.map((f) => [f.id, f.reason]));
  assert.equal(frontierByReason.get(C), "breadth-cap");
  assert.equal(frontierByReason.get(D), "depth-cap");
  assert.equal(frontierByReason.get(E), "depth-cap");
  // Reaching maxHops/breadth by design is not the same thing as running out of the call budget.
  assert.equal(result.budgetExhausted, false);
  assert.equal(result.adapterCallsUsed, 3);
});

test("traceGraph reports budgetExhausted honestly, distinct from a depth/breadth cap reached by design", async () => {
  const adapter = new MapChainAdapter(
    "ethereum",
    new Map([
      [
        CENTER,
        {
          available: true,
          transactions: [ethTx("h-a", CENTER, A, "1", "out", "2026-01-05T00:00:00Z"), ethTx("h-b", CENTER, B, "1", "out", "2026-01-04T00:00:00Z")],
        },
      ],
    ]),
  );
  const result = await traceGraph({ chain: "ethereum", value: CENTER }, adapter, { ...DEFAULT_OPTS, maxAdapterCalls: 1 });
  assert.equal(result.budgetExhausted, true);
  assert.equal(result.adapterCallsUsed, 1);
  assert.deepEqual(result.expandedIds, [CENTER]);
  const frontierByReason = new Map(result.frontier.map((f) => [f.id, f.reason]));
  assert.equal(frontierByReason.get(A), "budget-exhausted");
  assert.equal(frontierByReason.get(B), "budget-exhausted");
});

test("traceGraph: a chain adapter that can't check a node becomes an 'unavailable' frontier entry, never a silent dead end", async () => {
  const adapter = new MapChainAdapter(
    "ethereum",
    new Map([[CENTER, { available: true, transactions: [ethTx("h-a", CENTER, A, "1", "out", "2026-01-05T00:00:00Z")] }]]),
  );
  // A has no fixture at all -- MapChainAdapter reports { available: false }, same as a real RPC failure.
  const result = await traceGraph({ chain: "ethereum", value: CENTER }, adapter, DEFAULT_OPTS);
  assert.deepEqual(result.expandedIds, [CENTER]);
  assert.deepEqual(result.frontier, [{ id: A, reason: "unavailable" }]);
});

test("tracePath finds a real multi-hop path where every hop individually satisfies the filters", async () => {
  const adapter = new MapChainAdapter(
    "ethereum",
    new Map([
      [
        CENTER,
        {
          available: true,
          transactions: [
            // A decoy native transfer -- must be ignored, since filters.token === "USDC".
            ethTx("h-decoy", CENTER, C, "500", "out", "2026-01-09T00:00:00Z"),
            // Token-only transfer: "self" at the native level (same convention the real adapters
            // use — see packages/features/visualizer/tests/graph.test.ts), so only the token edge draws.
            ethTx("h1", CENTER, CENTER, "0", "self", "2026-01-10T00:00:00Z", [usdc("out", CENTER, A, "150")]),
          ],
        },
      ],
      [A, { available: true, transactions: [ethTx("h2", A, A, "0", "self", "2026-01-15T00:00:00Z", [usdc("out", A, TARGET, "120")])] }],
    ]),
  );

  const result = await tracePath(
    { chain: "ethereum", value: CENTER },
    { chain: "ethereum", value: TARGET },
    adapter,
    { token: "USDC", minAmount: "100", sinceTimestamp: "2026-01-01T00:00:00Z" },
    DEFAULT_OPTS,
  );

  assert.equal(result.found, true);
  assert.deepEqual(result.path.map((e) => e.id), ["h1", "h2"]);
  assert.equal(result.hopsSearched, 2);
  assert.equal(result.budgetExhausted, false);
});

test("tracePath: the only edge fails the filter -> not found, and honestly not budget-exhausted (the graph genuinely dead-ends)", async () => {
  const adapter = new MapChainAdapter(
    "ethereum",
    new Map([[CENTER, { available: true, transactions: [ethTx("h1", CENTER, A, "0", "out", "2026-01-10T00:00:00Z", [usdc("out", CENTER, A, "150")])] }]]),
  );
  const result = await tracePath(
    { chain: "ethereum", value: CENTER },
    { chain: "ethereum", value: TARGET },
    adapter,
    { token: "USDC", minAmount: "1000" }, // the real edge only carries 150
    DEFAULT_OPTS,
  );
  assert.equal(result.found, false);
  assert.equal(result.budgetExhausted, false);
});

test("tracePath: a real matching path exists past the depth cap -> not found, but budgetExhausted is true (truncated, not disproven)", async () => {
  const adapter = new MapChainAdapter(
    "ethereum",
    new Map([
      [CENTER, { available: true, transactions: [ethTx("h1", CENTER, A, "0", "out", "2026-01-10T00:00:00Z", [usdc("out", CENTER, A, "150")])] }],
      [A, { available: true, transactions: [ethTx("h2", A, TARGET, "0", "out", "2026-01-15T00:00:00Z", [usdc("out", A, TARGET, "120")])] }],
    ]),
  );
  const result = await tracePath(
    { chain: "ethereum", value: CENTER },
    { chain: "ethereum", value: TARGET },
    adapter,
    { token: "USDC", minAmount: "100" },
    { ...DEFAULT_OPTS, maxHops: 1 }, // TARGET is 2 hops away
  );
  assert.equal(result.found, false);
  assert.equal(result.budgetExhausted, true);
});

test("tracePath: a fetched edge that reaches the target counts even when the target isn't among the breadth most-recent neighbors", async () => {
  const adapter = new MapChainAdapter(
    "ethereum",
    new Map([
      [
        CENTER,
        {
          available: true,
          transactions: [
            ethTx("h-a", CENTER, A, "1", "out", "2026-01-05T00:00:00Z"),
            ethTx("h-b", CENTER, B, "1", "out", "2026-01-04T00:00:00Z"),
            ethTx("h-target", CENTER, TARGET, "1", "out", "2026-01-01T00:00:00Z"), // oldest -> outside breadth 1
          ],
        },
      ],
    ]),
  );
  const result = await tracePath({ chain: "ethereum", value: CENTER }, { chain: "ethereum", value: TARGET }, adapter, {}, { ...DEFAULT_OPTS, breadth: 1 });
  assert.equal(result.found, true);
  assert.deepEqual(result.path.map((e) => e.id), ["h-target"]);
  assert.equal(result.adapterCallsUsed, 1);
});

test("tracePath: the same address for from and to is an immediate, zero-call non-match", async () => {
  const adapter = new MapChainAdapter("ethereum", new Map());
  const result = await tracePath({ chain: "ethereum", value: CENTER }, { chain: "ethereum", value: CENTER }, adapter, {}, DEFAULT_OPTS);
  assert.deepEqual(result, {
    found: false,
    path: [],
    nodeChains: { [CENTER]: "ethereum" },
    hopsSearched: 0,
    nodesExplored: 0,
    adapterCallsUsed: 0,
    budgetExhausted: false,
    bridges: { enabled: false, protocol: null, lookupsUsed: 0, lookupFailures: [], deadEnds: [], malformedOperations: 0 },
  });
  assert.deepEqual(adapter.calls, []);
});

async function withStore<T>(fn: (store: JsonFileLabelStore) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "tracer-test-"));
  try {
    return await fn(new JsonFileLabelStore(join(dir, "labels.json")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("buildTraceGraph/buildTracePath attach real label/tag/entity lookups from the label store", async () =>
  withStore(async (store) => {
    await store.addLabel({ address: { chain: "ethereum", value: A }, name: "Known Exchange", confidence: "verified", source: { description: "test", url: "https://example.com", addedAt: "2026-01-01" } });
    const adapter = new MapChainAdapter(
      "ethereum",
      new Map([[CENTER, { available: true, transactions: [ethTx("h1", CENTER, A, "1", "out", "2026-01-05T00:00:00Z")] }]]),
    );

    const graphReport = await buildTraceGraph({ chain: "ethereum", value: CENTER }, adapter, store, DEFAULT_OPTS);
    const aNode = graphReport.nodes.find((n) => n.id === A);
    assert.equal(aNode?.label?.name, "Known Exchange");
    // A has no fixture of its own, so its transactions were never fetched -- honestly "frontier"/"unavailable",
    // not "expanded". The label still shows up, since node labeling doesn't depend on expansion.
    assert.equal(aNode?.role, "frontier");
    assert.equal(aNode?.frontierReason, "unavailable");

    const pathReport = await buildTracePath({ chain: "ethereum", value: CENTER }, { chain: "ethereum", value: A }, adapter, store, {}, DEFAULT_OPTS);
    assert.equal(pathReport.found, true);
    assert.equal(pathReport.nodes.find((n) => n.id === A)?.label?.name, "Known Exchange");
  }));
