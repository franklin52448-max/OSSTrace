import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonFileLabelStore,
  type Address,
  type Balance,
  type ChainAdapter,
  type ChainId,
  type TransactionSummary,
  type TransactionsResult,
} from "@opentrace/core";
import { buildGraph, deriveGraph } from "../src/graph.ts";
import { addDecimal } from "../src/decimal.ts";

/** A real, concrete ChainAdapter implementation for tests — not a mocking framework, a small working stand-in. */
class FixedChainAdapter implements ChainAdapter {
  readonly chain: ChainId;
  readonly #transactions: TransactionsResult;
  calls: { address: string; limit: number }[] = [];
  constructor(chain: ChainId, transactions: TransactionsResult) {
    this.chain = chain;
    this.#transactions = transactions;
  }
  async getBalance(address: string): Promise<Balance> {
    return { chain: this.chain, address, native: { symbol: "ETH", amount: "0", decimals: 18 }, asOf: "2026-10-21T00:00:00Z" };
  }
  async getRecentTransactions(address: string, limit: number): Promise<TransactionsResult> {
    this.calls.push({ address, limit });
    return this.#transactions;
  }
}

const CENTER = "0x1111111111111111111111111111111111111111";
const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function ethTx(hash: string, from: string, to: string | null, valueNative: string, direction: TransactionSummary["direction"]): TransactionSummary {
  return { chain: "ethereum", hash, timestamp: "2026-10-20T12:00:00.000Z", from, to, valueNative, direction };
}

async function withStore<T>(fn: (store: JsonFileLabelStore) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "visualizer-graph-test-"));
  try {
    return await fn(new JsonFileLabelStore(join(dir, "labels.json")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("addDecimal sums decimal strings exactly, without float loss", () => {
  assert.equal(addDecimal("0", "0"), "0");
  assert.equal(addDecimal("1.5", "2.25"), "3.75");
  assert.equal(addDecimal("0.1", "0.2"), "0.3");
  assert.equal(addDecimal("0.000000000000000001", "1"), "1.000000000000000001");
  assert.equal(addDecimal("0.5", "0.5"), "1");
  assert.equal(addDecimal("123456789012345678901234567890", "1"), "123456789012345678901234567891");
});

test("deriveGraph: one node per distinct counterparty, one edge per real transfer, real direction", () => {
  const txs = [
    ethTx("0xh1", ALICE, CENTER, "1.5", "in"),
    ethTx("0xh2", CENTER, BOB, "0.25", "out"),
    ethTx("0xh3", ALICE, CENTER, "2", "in"),
    ethTx("0xh4", CENTER, ALICE, "0.5", "out"),
  ];
  const g = deriveGraph({ chain: "ethereum", value: CENTER }, txs);

  assert.equal(g.centerId, CENTER);
  // Alice has 3 edges, Bob 1 — ordered by edge count desc.
  assert.deepEqual(g.counterpartyIds, [ALICE, BOB]);
  assert.deepEqual(
    g.edges.map((e) => [e.hash, e.source, e.target, e.direction, e.valueNative]),
    [
      ["0xh1", ALICE, CENTER, "in", "1.5"],
      ["0xh2", CENTER, BOB, "out", "0.25"],
      ["0xh3", ALICE, CENTER, "in", "2"],
      ["0xh4", CENTER, ALICE, "out", "0.5"],
    ],
  );
  assert.deepEqual(g.stats.get(CENTER), { txCount: 4, inCount: 2, outCount: 2, totalIn: "3.5", totalOut: "0.75" });
  assert.deepEqual(g.stats.get(ALICE), { txCount: 3, inCount: 1, outCount: 2, totalIn: "0.5", totalOut: "3.5" });
  assert.deepEqual(g.stats.get(BOB), { txCount: 1, inCount: 1, outCount: 0, totalIn: "0.25", totalOut: "0" });
  assert.deepEqual(g.omitted, []);
});

test("deriveGraph: Ethereum addresses are merged case-insensitively (checksummed vs lowercase)", () => {
  const checksummedAlice = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
  const g = deriveGraph({ chain: "ethereum", value: CENTER.toUpperCase().replace("0X", "0x") }, [
    ethTx("0xh1", checksummedAlice, CENTER, "1", "in"),
    ethTx("0xh2", CENTER, ALICE, "1", "out"),
  ]);
  assert.equal(g.centerId, CENTER);
  assert.deepEqual(g.counterpartyIds, [ALICE]);
  assert.equal(g.edges.length, 2);
});

function tokenTransfer(
  direction: "in" | "out" | "self",
  counterparty: string | null,
  amount: string,
): NonNullable<TransactionSummary["tokenTransfers"]>[number] {
  return {
    token: "0xToken000000000000000000000000000000001",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    rawAmount: `${Number(amount) * 1_000_000}`,
    amount,
    from: direction === "out" ? CENTER : counterparty,
    to: direction === "out" ? counterparty : CENTER,
    direction,
  };
}

test("deriveGraph: a token-only transaction (no resolvable native leg) still draws a token edge, not omitted", () => {
  // Real shape: an ERC-20-only transfer reports as "self" at the native level (no native value
  // moved involving this address as a plain transfer) but carries a real decoded token leg.
  const tx: TransactionSummary = { ...ethTx("0xtok1", CENTER, CENTER, "0", "self"), tokenTransfers: [tokenTransfer("out", BOB, "100.5")] };
  const g = deriveGraph({ chain: "ethereum", value: CENTER }, [tx]);

  assert.deepEqual(g.omitted, []);
  assert.deepEqual(g.counterpartyIds, [BOB]);
  assert.equal(g.edges.length, 1);
  const edge = g.edges[0]!;
  assert.equal(edge.kind, "token");
  assert.equal(edge.source, CENTER);
  assert.equal(edge.target, BOB);
  assert.equal(edge.valueNative, "0");
  assert.deepEqual(edge.token, { address: "0xToken000000000000000000000000000000001", symbol: "USDC", amount: "100.5", rawAmount: "100500000" });
});

test("deriveGraph: a transaction with both a resolved native leg and a token transfer draws both edges", () => {
  const tx: TransactionSummary = { ...ethTx("0xboth", CENTER, ALICE, "1", "out"), tokenTransfers: [tokenTransfer("out", ALICE, "50")] };
  const g = deriveGraph({ chain: "ethereum", value: CENTER }, [tx]);

  assert.deepEqual(g.omitted, []);
  assert.equal(g.edges.length, 2);
  assert.deepEqual(
    g.edges.map((e) => [e.id, e.kind]),
    [
      ["0xboth", "native"],
      ["0xboth#1", "token"],
    ],
  );
  // Only the native leg counts toward native totals — the token amount is a different currency.
  assert.deepEqual(g.stats.get(CENTER), { txCount: 2, inCount: 0, outCount: 2, totalIn: "0", totalOut: "1" });
});

test("deriveGraph: a token transfer whose own counterparty is unresolved or self is skipped, not invented", () => {
  const txSelf: TransactionSummary = { ...ethTx("0xselftok", CENTER, CENTER, "0", "self"), tokenTransfers: [tokenTransfer("self", null, "5")] };
  const txUnresolved: TransactionSummary = { ...ethTx("0xnotok", CENTER, CENTER, "0", "self"), tokenTransfers: [tokenTransfer("out", null, "5")] };
  const g = deriveGraph({ chain: "ethereum", value: CENTER }, [txSelf, txUnresolved]);

  assert.deepEqual(g.edges, []);
  assert.deepEqual(
    g.omitted.map((o) => o.hash),
    ["0xselftok", "0xnotok"],
  );
});

test("deriveGraph: two token transfers in one transaction both draw, with unique edge ids", () => {
  const tx: TransactionSummary = {
    ...ethTx("0xswap", CENTER, CENTER, "0", "self"),
    tokenTransfers: [tokenTransfer("out", ALICE, "10"), tokenTransfer("in", BOB, "20")],
  };
  const g = deriveGraph({ chain: "ethereum", value: CENTER }, [tx]);

  assert.deepEqual(g.omitted, []);
  assert.deepEqual(
    g.edges.map((e) => e.id),
    ["0xswap", "0xswap#1"],
  );
  assert.deepEqual(g.counterpartyIds.sort(), [ALICE, BOB].sort());
});

test("deriveGraph: self-transfers, contract creations, and unresolved counterparties are omitted, never invented", () => {
  const txs = [
    ethTx("0xself", CENTER, CENTER, "1", "self"),
    ethTx("0xcreate", CENTER, null, "0", "out"),
    ethTx("0xok", CENTER, BOB, "3", "out"),
  ];
  const g = deriveGraph({ chain: "ethereum", value: CENTER }, txs);
  assert.deepEqual(g.counterpartyIds, [BOB]);
  assert.deepEqual(
    g.omitted.map((o) => [o.hash, o.reason]),
    [
      ["0xself", "self-transfer"],
      ["0xcreate", "no-counterparty"],
    ],
  );
});

test("deriveGraph: the Solana adapter's honest 'unresolved' fallbacks never become nodes", () => {
  const center = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const counterparty = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
  const sol = (hash: string, from: string, to: string | null, valueNative: string, direction: TransactionSummary["direction"]): TransactionSummary => ({
    chain: "solana",
    hash,
    timestamp: "2026-10-20T12:00:00.000Z",
    from,
    to,
    valueNative,
    direction,
  });
  const g = deriveGraph({ chain: "solana", value: center }, [
    // Decoded native transfer: real counterparty.
    sol("sig1", counterparty, center, "0.5", "in"),
    // Balance-delta fallback, net inflow: the adapter does not know who sent it.
    sol("sig2", "unresolved (non-transfer instruction)", center, "0.1", "in"),
    // Balance-delta fallback, net outflow: no `to`.
    sol("sig3", center, null, "0.000005", "out"),
    // Transaction the RPC couldn't return at all (the adapter labels it "self").
    sol("sig4", "unknown", null, "0", "self"),
    // Zero net balance change, no decoded transfer (also labelled "self" by the adapter).
    sol("sig5", "unresolved (non-transfer instruction)", center, "0", "self"),
  ]);
  assert.deepEqual(g.counterpartyIds, [counterparty]);
  assert.deepEqual(
    g.edges.map((e) => e.hash),
    ["sig1"],
  );
  assert.deepEqual(
    g.omitted.map((o) => [o.hash, o.reason]),
    [
      ["sig2", "counterparty-unresolved"],
      ["sig3", "no-counterparty"],
      ["sig4", "counterparty-unresolved"],
      ["sig5", "counterparty-unresolved"],
    ],
  );
});

test("deriveGraph: Solana base58 is case-sensitive — differently-cased addresses stay distinct nodes", () => {
  const center = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const a = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
  const b = "5q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
  const tx = (hash: string, from: string): TransactionSummary => ({
    chain: "solana",
    hash,
    timestamp: "2026-10-20T12:00:00.000Z",
    from,
    to: center,
    valueNative: "1",
    direction: "in",
  });
  const g = deriveGraph({ chain: "solana", value: center }, [tx("s1", a), tx("s2", b)]);
  assert.equal(g.counterpartyIds.length, 2);
});

test("deriveGraph: a repeated tx hash still gets unique edge ids", () => {
  const g = deriveGraph({ chain: "ethereum", value: CENTER }, [ethTx("0xdup", ALICE, CENTER, "1", "in"), ethTx("0xdup", BOB, CENTER, "2", "in")]);
  assert.deepEqual(
    g.edges.map((e) => e.id),
    ["0xdup", "0xdup#1"],
  );
});

test("buildGraph: center + counterparties carry real labels/tags from the label store; one adapter call", async () => {
  await withStore(async (store) => {
    const source = { description: "unit test", url: "https://example.test", addedAt: "2026-10-21" };
    const bobAddress: Address = { chain: "ethereum", value: BOB };
    await store.addLabel({ address: bobAddress, name: "Sanctioned Bob", confidence: "verified", source });
    await store.addTag({ address: bobAddress, tag: "sanctioned", source });

    const adapter = new FixedChainAdapter("ethereum", {
      available: true,
      transactions: [ethTx("0xh1", ALICE, CENTER, "1", "in"), ethTx("0xh2", CENTER, BOB, "4", "out"), ethTx("0xh3", CENTER, CENTER, "1", "self")],
    });

    const report = await buildGraph({ chain: "ethereum", value: CENTER }, adapter, store, 10);

    assert.deepEqual(adapter.calls, [{ address: CENTER, limit: 10 }]);
    assert.equal(report.hops, 1);
    assert.deepEqual(report.transactions, { available: true, fetched: 3 });
    assert.deepEqual(report.center, { chain: "ethereum", value: CENTER });

    assert.deepEqual(
      report.nodes.map((n) => [n.id, n.role]),
      [
        [CENTER, "center"],
        [ALICE, "counterparty"],
        [BOB, "counterparty"],
      ],
    );
    const bob = report.nodes.find((n) => n.id === BOB);
    assert.equal(bob?.label?.name, "Sanctioned Bob");
    assert.deepEqual(
      bob?.tags.map((t) => t.tag),
      ["sanctioned"],
    );
    const alice = report.nodes.find((n) => n.id === ALICE);
    assert.equal(alice?.label, null);
    assert.deepEqual(alice?.tags, []);

    assert.equal(report.edges.length, 2);
    assert.deepEqual(
      report.omitted.map((o) => o.reason),
      ["self-transfer"],
    );
  });
});

test("buildGraph: unavailable history returns just the (labeled) center node and the adapter's reason — no invented edges", async () => {
  await withStore(async (store) => {
    const source = { description: "unit test", url: "https://example.test", addedAt: "2026-10-21" };
    await store.addLabel({ address: { chain: "ethereum", value: CENTER }, name: "Center Co", confidence: "verified", source });
    const adapter = new FixedChainAdapter("ethereum", { available: false, reason: "no ETHERSCAN_API_KEY configured" });

    const report = await buildGraph({ chain: "ethereum", value: CENTER }, adapter, store);

    assert.deepEqual(report.transactions, { available: false, reason: "no ETHERSCAN_API_KEY configured" });
    assert.equal(report.nodes.length, 1);
    assert.equal(report.nodes[0]?.role, "center");
    assert.equal(report.nodes[0]?.label?.name, "Center Co");
    assert.deepEqual(report.edges, []);
    assert.deepEqual(report.omitted, []);
  });
});
