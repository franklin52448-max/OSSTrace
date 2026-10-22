import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileLabelStore, type Address, type Balance, type ChainAdapter, type TransactionsResult } from "@osstrace/core";
import { lookupAddress } from "../src/lookup.ts";

/** A real, concrete ChainAdapter implementation for tests — not a mocking framework, a small working stand-in. */
class FixedChainAdapter implements ChainAdapter {
  readonly chain = "ethereum" as const;
  readonly #balance: Balance | Error;
  readonly #transactions: TransactionsResult | Error;
  /** Pass an Error for either to make that call throw, the way a real adapter does when its RPC is down. */
  constructor(balance: Balance | Error, transactions: TransactionsResult | Error) {
    this.#balance = balance;
    this.#transactions = transactions;
  }
  async getBalance(): Promise<Balance> {
    if (this.#balance instanceof Error) throw this.#balance;
    return this.#balance;
  }
  async getRecentTransactions(): Promise<TransactionsResult> {
    if (this.#transactions instanceof Error) throw this.#transactions;
    return this.#transactions;
  }
}

test("lookupAddress merges adapter data with store data for an address with no label", async () => {
  const dir = await mkdtemp(join(tmpdir(), "explorer-lookup-test-"));
  try {
    const store = new JsonFileLabelStore(join(dir, "labels.json"));
    const address: Address = { chain: "ethereum", value: "0xabc" };
    const balance: Balance = { chain: "ethereum", address: "0xabc", native: { symbol: "ETH", amount: "1.5", decimals: 18 }, asOf: "2026-10-21T00:00:00Z" };
    const transactions: TransactionsResult = { available: true, transactions: [] };
    const adapter = new FixedChainAdapter(balance, transactions);

    const report = await lookupAddress(address, adapter, store);

    assert.deepEqual(report.balance, { available: true, balance });
    assert.deepEqual(report.transactions, transactions);
    assert.equal(report.label, null);
    assert.deepEqual(report.tags, []);
    assert.equal(report.entity, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lookupAddress surfaces a real label and tags from the store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "explorer-lookup-test-"));
  try {
    const store = new JsonFileLabelStore(join(dir, "labels.json"));
    const address: Address = { chain: "ethereum", value: "0xdef" };
    const source = { description: "unit test", url: "https://example.test", addedAt: "2026-10-21" };
    await store.addLabel({ address, name: "Test Entity", confidence: "verified", source });
    await store.addTag({ address, tag: "sanctioned", source });

    const balance: Balance = { chain: "ethereum", address: "0xdef", native: { symbol: "ETH", amount: "0", decimals: 18 }, asOf: "2026-10-21T00:00:00Z" };
    const adapter = new FixedChainAdapter(balance, { available: false, reason: "no key configured" });

    const report = await lookupAddress(address, adapter, store);

    assert.equal(report.label?.name, "Test Entity");
    assert.equal(report.tags.length, 1);
    assert.equal(report.tags[0]?.tag, "sanctioned");
    assert.deepEqual(report.transactions, { available: false, reason: "no key configured" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed balance call is reported on its own field and hides nothing else in the report", async () => {
  const dir = await mkdtemp(join(tmpdir(), "explorer-lookup-test-"));
  try {
    const store = new JsonFileLabelStore(join(dir, "labels.json"));
    const address: Address = { chain: "ethereum", value: "0xfeed" };
    const source = { description: "unit test", url: "https://example.test", addedAt: "2026-10-22" };
    await store.addLabel({ address, name: "Still Labelled", confidence: "verified", source });
    await store.addTag({ address, tag: "sanctioned", source });
    const transactions: TransactionsResult = {
      available: true,
      transactions: [
        { chain: "ethereum", hash: "0xt1", timestamp: "2026-10-22T00:00:00.000Z", from: "0xa", to: "0xfeed", valueNative: "1", direction: "in" },
      ],
    };
    const adapter = new FixedChainAdapter(new Error("eth_getBalance HTTP 503 from the configured Ethereum RPC"), transactions);

    // Before ADR 0014 this rejected outright (Promise.all), and the Explorer answered 502.
    const report = await lookupAddress(address, adapter, store);

    assert.deepEqual(report.balance, { available: false, reason: "eth_getBalance HTTP 503 from the configured Ethereum RPC" });
    assert.deepEqual(report.transactions, transactions, "the transaction history that did come back is still there");
    assert.equal(report.label?.name, "Still Labelled");
    assert.deepEqual(report.tags.map((t) => t.tag), ["sanctioned"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a transactions call that throws is reported as unavailable and doesn't take the balance down", async () => {
  const dir = await mkdtemp(join(tmpdir(), "explorer-lookup-test-"));
  try {
    const store = new JsonFileLabelStore(join(dir, "labels.json"));
    const address: Address = { chain: "ethereum", value: "0xbeef" };
    const balance: Balance = { chain: "ethereum", address: "0xbeef", native: { symbol: "ETH", amount: "2", decimals: 18 }, asOf: "2026-10-22T00:00:00Z" };
    const adapter = new FixedChainAdapter(balance, new Error("socket hang up"));

    const report = await lookupAddress(address, adapter, store);

    assert.deepEqual(report.balance, { available: true, balance });
    assert.deepEqual(report.transactions, { available: false, reason: "socket hang up" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
