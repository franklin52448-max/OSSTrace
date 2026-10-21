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
});
