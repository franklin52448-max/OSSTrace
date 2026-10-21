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
import { cachedLookupAddress, DEFAULT_TX_LIMIT, LOOKUP_POPULARITY_TOPIC, reportCacheKey } from "../src/cachedLookup.ts";

/** Counts how many times getBalance/getRecentTransactions are actually called, to prove caching works. */
class CountingAdapter implements ChainAdapter {
  readonly chain = "ethereum" as const;
  balanceCalls = 0;
  txCalls = 0;
  /** Every `limit` the adapter was actually asked for, in call order. */
  txLimits: number[] = [];

  async getBalance(address: string): Promise<Balance> {
    this.balanceCalls++;
    return { chain: "ethereum", address, native: { symbol: "ETH", amount: "1", decimals: 18 }, asOf: "2026-10-21T00:00:00Z" };
  }

  async getRecentTransactions(_address: string, limit: number): Promise<TransactionsResult> {
    this.txCalls++;
    this.txLimits.push(limit);
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

test("different transaction limits on the same address get separate cache entries", async () => {
  await withTempStore(async (storePath) => {
    const store = new JsonFileLabelStore(storePath);
    const cache = new InMemoryCache();
    const adapter = new CountingAdapter();
    const address: Address = { chain: "ethereum", value: "0xabc" };

    await cachedLookupAddress(address, adapter, store, cache, 5);
    await cachedLookupAddress(address, adapter, store, cache, 50);
    assert.deepEqual(adapter.txLimits, [5, 50], "a limit=50 lookup must not be served the cached limit=5 report");

    // Each limit is still cached on its own: repeating either one doesn't reach the adapter again.
    await cachedLookupAddress(address, adapter, store, cache, 5);
    await cachedLookupAddress(address, adapter, store, cache, 50);
    assert.deepEqual(adapter.txLimits, [5, 50]);
    assert.ok(await cache.get(reportCacheKey(address, 5)));
    assert.ok(await cache.get(reportCacheKey(address, 50)));
  });
});

test("popularity is ranked per address, regardless of which limits were requested", async () => {
  await withTempStore(async (storePath) => {
    const store = new JsonFileLabelStore(storePath);
    const cache = new InMemoryCache();
    const adapter = new CountingAdapter();
    const address: Address = { chain: "ethereum", value: "0xabc" };

    await cachedLookupAddress(address, adapter, store, cache, 5);
    await cachedLookupAddress(address, adapter, store, cache, 50);

    // The indexer parses these back into addresses — a limit suffix here would break it.
    assert.deepEqual(await cache.topHits(LOOKUP_POPULARITY_TOPIC, 5), ["ethereum:0xabc"]);
  });
});

test("a default-limit lookup uses the same cache key the background indexer refreshes", async () => {
  await withTempStore(async (storePath) => {
    const store = new JsonFileLabelStore(storePath);
    const cache = new InMemoryCache();
    const adapter = new CountingAdapter();
    const address: Address = { chain: "ethereum", value: "0xabc" };

    await cachedLookupAddress(address, adapter, store, cache);
    assert.deepEqual(adapter.txLimits, [DEFAULT_TX_LIMIT]);
    assert.ok(await cache.get(reportCacheKey(address, DEFAULT_TX_LIMIT)));

    // An explicit limit equal to the default is the same entry, not a second fetch.
    await cachedLookupAddress(address, adapter, store, cache, DEFAULT_TX_LIMIT);
    assert.equal(adapter.txCalls, 1);
  });
});

test("a cache hit still re-reads labels, so a label added or changed after caching shows immediately", async () => {
  await withTempStore(async (storePath) => {
    const store = new JsonFileLabelStore(storePath);
    const cache = new InMemoryCache();
    const adapter = new CountingAdapter();
    const address: Address = { chain: "ethereum", value: "0xabc" };

    const first = await cachedLookupAddress(address, adapter, store, cache);
    assert.equal(first.label, null);

    await store.addLabel({
      address,
      name: "Added after caching",
      confidence: "verified",
      source: { description: "test source", url: "https://example.org/source", addedAt: "2026-10-21" },
    });
    const second = await cachedLookupAddress(address, adapter, store, cache);
    assert.equal(adapter.balanceCalls, 1, "chain data still came from the cache");
    assert.equal(second.label?.name, "Added after caching", "but the label is fresh");
  });
});
