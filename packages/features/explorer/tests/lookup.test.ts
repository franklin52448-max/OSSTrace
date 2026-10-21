import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileLabelStore, type Address, type Balance, type ChainAdapter, type TransactionsResult } from "@opentrace/core";
import { lookupAddress } from "../src/lookup.ts";

/** A real, concrete ChainAdapter implementation for tests — not a mocking framework, a small working stand-in. */
class FixedChainAdapter implements ChainAdapter {
  readonly chain = "ethereum" as const;
  readonly #balance: Balance;
  readonly #transactions: TransactionsResult;
  constructor(balance: Balance, transactions: TransactionsResult) {
    this.#balance = balance;
    this.#transactions = transactions;
  }
  async getBalance(): Promise<Balance> {
    return this.#balance;
  }
  async getRecentTransactions(): Promise<TransactionsResult> {
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

    assert.deepEqual(report.balance, balance);
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
