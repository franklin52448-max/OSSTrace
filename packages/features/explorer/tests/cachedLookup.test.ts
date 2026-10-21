import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryCache,
  JsonFileLabelStore,
  type Address,
  type Balance,
  type ChainAdapter,
  type TransactionsResult,
} from "@opentrace/core";
import { cachedLookupAddress, LOOKUP_POPULARITY_TOPIC } from "../src/cachedLookup.ts";

/** Counts how many times getBalance/getRecentTransactions are actually called, to prove caching works. */
class CountingAdapter implements ChainAdapter {
  readonly chain = "ethereum" as const;
  balanceCalls = 0;
  txCalls = 0;

  async getBalance(address: string): Promise<Balance> {
    this.balanceCalls++;
    return { chain: "ethereum", address, native: { symbol: "ETH", amount: "1", decimals: 18 }, asOf: "2026-10-21T00:00:00Z" };
  }

  async getRecentTransactions(): Promise<TransactionsResult> {
    this.txCalls++;
    return { available: true, transactions: [] };
  }
}

async function withTempStore(run: (storePath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "cached-lookup-test-"));
  try {
    await run(join(dir, "labels.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a cache miss calls the adapter; a repeat lookup within the TTL doesn't", async () => {
  await withTempStore(async (storePath) => {
    const store = new JsonFileLabelStore(storePath);
    const cache = new InMemoryCache();
    const adapter = new CountingAdapter();
    const address: Address = { chain: "ethereum", value: "0xabc" };

    await cachedLookupAddress(address, adapter, store, cache);
    assert.equal(adapter.balanceCalls, 1);

    await cachedLookupAddress(address, adapter, store, cache);
    assert.equal(adapter.balanceCalls, 1, "second lookup should be served from cache, not the adapter");
  });
});

test("different addresses are cached independently", async () => {
  await withTempStore(async (storePath) => {
    const store = new JsonFileLabelStore(storePath);
    const cache = new InMemoryCache();
    const adapter = new CountingAdapter();

    await cachedLookupAddress({ chain: "ethereum", value: "0xabc" }, adapter, store, cache);
    await cachedLookupAddress({ chain: "ethereum", value: "0xdef" }, adapter, store, cache);
    assert.equal(adapter.balanceCalls, 2);
  });
});

test("every lookup, hit or miss, records a popularity hit", async () => {
  await withTempStore(async (storePath) => {
    const store = new JsonFileLabelStore(storePath);
    const cache = new InMemoryCache();
    const adapter = new CountingAdapter();
    const address: Address = { chain: "ethereum", value: "0xabc" };

    await cachedLookupAddress(address, adapter, store, cache);
    await cachedLookupAddress(address, adapter, store, cache);
    await cachedLookupAddress(address, adapter, store, cache);

    const top = await cache.topHits(LOOKUP_POPULARITY_TOPIC, 5);
    assert.deepEqual(top, ["ethereum:0xabc"]);
  });
});
