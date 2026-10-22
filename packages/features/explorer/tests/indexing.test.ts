import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { InMemoryCache, JsonFileLabelStore, type ChainAdapter, type ChainId } from "@osstrace/core";
import { DEFAULT_TX_LIMIT, LOOKUP_POPULARITY_TOPIC, reportCacheKey } from "../src/cachedLookup.ts";
import { InMemoryEventBus, type IndexerEvent } from "../src/events.ts";
import { Indexer } from "../src/indexing.ts";
import { ScriptedAdapter, tx, withTempDir } from "./helpers.ts";

const WATCHED = { chain: "ethereum" as const, value: "0xwatched" };

async function setup(dir: string, topN = 20) {
  const adapter = new ScriptedAdapter();
  const registry = new Map<ChainId, ChainAdapter>([["ethereum", adapter]]);
  const cache = new InMemoryCache();
  const bus = new InMemoryEventBus();
  const events: IndexerEvent[] = [];
  await bus.subscribe((e) => events.push(e));
  const indexer = new Indexer({ registry, store: new JsonFileLabelStore(join(dir, "labels.json")), cache, bus, intervalMs: 30_000, topN });
  return { adapter, cache, bus, events, indexer };
}

const newTxEvents = (events: IndexerEvent[]) => events.filter((e) => e.type === "new_transactions");

test("a transaction that lands between two cycles is published once, with no extra adapter calls", async () => {
  await withTempDir(async (dir) => {
    const { adapter, cache, events, indexer } = await setup(dir);
    adapter.history = [tx(2), tx(1)];
    await cache.recordHit(LOOKUP_POPULARITY_TOPIC, "ethereum:0xwatched");

    await indexer.runCycle();
    assert.equal(newTxEvents(events).length, 0, "first cycle only sets the baseline");

    adapter.land(tx(3));
    await indexer.runCycle();
    const published = newTxEvents(events);
    assert.equal(published.length, 1);
    assert.deepEqual(published[0], {
      type: "new_transactions",
      address: WATCHED,
      transactions: [tx(3)],
      windowOverflow: false,
      detectedAt: (published[0] as { detectedAt: string }).detectedAt,
    });

    await indexer.runCycle();
    assert.equal(newTxEvents(events).length, 1, "the same transaction is never published twice");
    assert.equal(adapter.txCalls, 3, "exactly one history fetch per cycle — the same calls the indexer always made");
  });
});

test("the indexer still warms the cache exactly as before", async () => {
  await withTempDir(async (dir) => {
    const { adapter, cache, indexer } = await setup(dir);
    adapter.history = [tx(1)];
    await cache.recordHit(LOOKUP_POPULARITY_TOPIC, "ethereum:0xwatched");
    await indexer.runCycle();
    const cached = await cache.get(reportCacheKey(WATCHED, DEFAULT_TX_LIMIT));
    assert.ok(cached);
    assert.deepEqual(JSON.parse(cached).transactions, { available: true, transactions: [tx(1)] });
  });
});

test("cycle_completed reports which addresses are live and which can't be read, and why", async () => {
  await withTempDir(async (dir) => {
    const { adapter, cache, events, indexer } = await setup(dir);
    await cache.recordHit(LOOKUP_POPULARITY_TOPIC, "ethereum:0xwatched");
    adapter.unavailable = "no ETHERSCAN_API_KEY configured";
    const cycle = await indexer.runCycle();
    assert.deepEqual(cycle.live, []);
    assert.deepEqual(cycle.notLive, [{ key: "ethereum:0xwatched", reason: "no ETHERSCAN_API_KEY configured" }]);
    assert.equal(cycle.topN, 20);
    assert.equal(events.at(-1)?.type, "cycle_completed");

    adapter.unavailable = null;
    adapter.history = [tx(1)];
    assert.deepEqual((await indexer.runCycle()).live, ["ethereum:0xwatched"]);
  });
});

test("an unavailable or failed fetch keeps the baseline, so the next good fetch reports only what's really new", async () => {
  await withTempDir(async (dir) => {
    const { adapter, cache, events, indexer } = await setup(dir);
    await cache.recordHit(LOOKUP_POPULARITY_TOPIC, "ethereum:0xwatched");
    adapter.history = [tx(1)];
    await indexer.runCycle();

    adapter.unavailable = "rate limited";
    await indexer.runCycle();
    adapter.unavailable = null;
    adapter.throwError = "socket hang up";
    const failed = await indexer.runCycle();
    assert.match(failed.notLive[0]?.reason ?? "", /socket hang up/);
    adapter.throwError = null;

    adapter.land(tx(2));
    await indexer.runCycle();
    const published = newTxEvents(events);
    assert.equal(published.length, 1);
    assert.deepEqual(published[0]?.type === "new_transactions" && published[0].transactions.map((t) => t.hash), ["0xtx2"]);
  });
});

test("an address that drops out of the top N loses its baseline (bounded memory, no stale burst on return)", async () => {
  await withTempDir(async (dir) => {
    const { adapter, cache, events, indexer } = await setup(dir, 1);
    adapter.history = [tx(1)];
    await cache.recordHit(LOOKUP_POPULARITY_TOPIC, "ethereum:0xwatched");
    await indexer.runCycle();
    assert.equal(indexer.baselineCount, 1);

    // Another address overtakes it in popularity; with topN = 1 the watched one is no longer refreshed.
    for (let i = 0; i < 3; i++) await cache.recordHit(LOOKUP_POPULARITY_TOPIC, "ethereum:0xother");
    await indexer.runCycle();
    assert.equal(indexer.baselineCount, 1, "only the address actually refreshed this cycle keeps a baseline");

    // While unwatched, transactions land. When it comes back, it re-baselines instead of pushing them as "just happened".
    adapter.land(tx(2));
    for (let i = 0; i < 5; i++) await cache.recordHit(LOOKUP_POPULARITY_TOPIC, "ethereum:0xwatched");
    await indexer.runCycle();
    assert.equal(newTxEvents(events).length, 0);
  });
});

test("without a bus the indexer is the plain cache warmer it always was", async () => {
  await withTempDir(async (dir) => {
    const adapter = new ScriptedAdapter();
    const cache = new InMemoryCache();
    await cache.recordHit(LOOKUP_POPULARITY_TOPIC, "ethereum:0xwatched");
    const indexer = new Indexer({
      registry: new Map<ChainId, ChainAdapter>([["ethereum", adapter]]),
      store: new JsonFileLabelStore(join(dir, "labels.json")),
      cache,
      intervalMs: 30_000,
      topN: 20,
    });
    await indexer.runCycle();
    adapter.land(tx(1));
    await indexer.runCycle();
    assert.equal(adapter.txCalls, 2);
  });
});

test("start() runs a cycle immediately and stop() halts the loop", async () => {
  await withTempDir(async (dir) => {
    const { adapter, cache, events, indexer } = await setup(dir);
    await cache.recordHit(LOOKUP_POPULARITY_TOPIC, "ethereum:0xwatched");
    indexer.start();
    await indexer.stop();
    assert.equal(adapter.txCalls, 1);
    assert.equal(events.filter((e) => e.type === "cycle_completed").length, 1);
  });
});
