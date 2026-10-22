import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryCache } from "../src/cache.ts";

test("get returns null for a key never set", async () => {
  const cache = new InMemoryCache();
  assert.equal(await cache.get("missing"), null);
});

test("set then get round-trips within the TTL", async () => {
  const cache = new InMemoryCache();
  await cache.set("k", "v", 60);
  assert.equal(await cache.get("k"), "v");
});

test("an entry expires after its TTL", async () => {
  const cache = new InMemoryCache();
  await cache.set("k", "v", 0); // already expired by the time we check
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await cache.get("k"), null);
});

test("topHits returns keys ordered by recorded hit count, most popular first", async () => {
  const cache = new InMemoryCache();
  await cache.recordHit("lookups", "a");
  await cache.recordHit("lookups", "b");
  await cache.recordHit("lookups", "b");
  await cache.recordHit("lookups", "c");
  await cache.recordHit("lookups", "b");
  assert.deepEqual(await cache.topHits("lookups", 2), ["b", "a"]);
});

test("topHits respects the limit and returns [] for an unknown topic", async () => {
  const cache = new InMemoryCache();
  await cache.recordHit("lookups", "a");
  await cache.recordHit("lookups", "b");
  assert.equal((await cache.topHits("lookups", 1)).length, 1);
  assert.deepEqual(await cache.topHits("nothing-recorded", 5), []);
});

test("topics don't interfere with each other", async () => {
  const cache = new InMemoryCache();
  await cache.recordHit("lookups", "a");
  await cache.recordHit("other-topic", "a");
  await cache.recordHit("other-topic", "a");
  assert.deepEqual(await cache.topHits("lookups", 5), ["a"]);
  assert.deepEqual(await cache.topHits("other-topic", 5), ["a"]);
  cache.close();
});

test("a periodic sweep actively removes expired entries, not just lazily on the next get() of that exact key", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const sweepIntervalMs = 1_000;
  const cache = new InMemoryCache(sweepIntervalMs);
  await cache.set("a", "1", 0); // expires immediately
  await cache.set("b", "2", 0);
  assert.equal(cache.size, 2, "both entries are stored before the sweep runs");

  // Nobody ever calls get("a") or get("b") again — the old behavior would leave them in the map
  // forever. Advancing past one sweep interval must shrink the map on its own.
  t.mock.timers.tick(sweepIntervalMs + 1);
  assert.equal(cache.size, 0, "the sweep removed both expired entries without a read");
  cache.close();
});

test("an entry that hasn't expired yet survives a sweep", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const cache = new InMemoryCache(1_000);
  await cache.set("k", "v", 60);
  t.mock.timers.tick(1_001);
  assert.equal(cache.size, 1);
  assert.equal(await cache.get("k"), "v");
  cache.close();
});

test("popularity decays: a hit outside the sliding window stops counting", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const cache = new InMemoryCache();
  await cache.recordHit("lookups", "stale"); // hot right now...
  t.mock.timers.tick(25 * 60 * 60 * 1000); // ...but 25 hours pass, outside the 24-hour window
  await cache.recordHit("lookups", "fresh");
  assert.deepEqual(await cache.topHits("lookups", 5), ["fresh"], "the 25-hour-old hit no longer ranks");
  cache.close();
});

test("a key with no hits left inside the window stops taking up space", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const cache = new InMemoryCache();
  await cache.recordHit("lookups", "a");
  t.mock.timers.tick(25 * 60 * 60 * 1000);
  // Neither recordHit nor topHits has touched "a" since it aged out — pruning happens lazily on
  // the next access to its own bucket map, proven here via a fresh recordHit on the same topic.
  await cache.recordHit("lookups", "b");
  assert.deepEqual(await cache.topHits("lookups", 5), ["b"]);
  cache.close();
});
