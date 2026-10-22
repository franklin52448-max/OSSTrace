import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { RedisCache } from "../src/redisCache.ts";

/**
 * Against a real Redis (REDIS_TEST_URL, default redis://127.0.0.1:6379) — proves the real
 * sliding-window popularity ranking (packages/core/src/cache.ts) works over real Redis sorted
 * sets, not just in `InMemoryCache`'s in-process version. Skips cleanly if no Redis is reachable.
 * Every topic name is unique per test (`randomUUID()`), so parallel test runs never share state.
 */
const REDIS_URL = process.env["REDIS_TEST_URL"] ?? "redis://127.0.0.1:6379";

async function redisReachable(): Promise<boolean> {
  const { hostname, port } = new URL(REDIS_URL);
  return await new Promise((resolve) => {
    const socket = connect({ host: hostname, port: Number(port || 6379) });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const reachable = await redisReachable();
const skip = !reachable && `no Redis at ${REDIS_URL}`;

test("get/set round-trip and TTL expiry over real Redis", { skip, timeout: 5000 }, async () => {
  const cache = new RedisCache(REDIS_URL);
  try {
    assert.equal(await cache.get(`k:${randomUUID()}`), null);
    const key = `k:${randomUUID()}`;
    await cache.set(key, "v", 60);
    assert.equal(await cache.get(key), "v");
    const expiring = `k:${randomUUID()}`;
    await cache.set(expiring, "v", 1);
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(await cache.get(expiring), null);
  } finally {
    await cache.close();
  }
});

test("topHits sums real Redis hits, most popular first", { skip, timeout: 5000 }, async () => {
  const cache = new RedisCache(REDIS_URL);
  const topic = `lookups:${randomUUID()}`;
  try {
    // Distinct counts (3/2/1), not just distinct ranks — a and c tying at the same count would
    // leave their relative order to Redis's own tie-break (reverse lexicographic), which isn't
    // part of this cache's contract and shouldn't be asserted on here.
    await cache.recordHit(topic, "a");
    await cache.recordHit(topic, "a");
    await cache.recordHit(topic, "b");
    await cache.recordHit(topic, "b");
    await cache.recordHit(topic, "b");
    await cache.recordHit(topic, "c");
    assert.deepEqual(await cache.topHits(topic, 2), ["b", "a"]);
  } finally {
    await cache.close();
  }
});

test("two concurrent topHits calls on the same topic don't corrupt each other's sum", { skip, timeout: 5000 }, async () => {
  // The API server and the standalone indexer both call topHits on the same "lookups" topic —
  // this is exactly that race, proving the per-call random scratch key (not a shared one) holds.
  const cache = new RedisCache(REDIS_URL);
  const topic = `lookups:${randomUUID()}`;
  try {
    await cache.recordHit(topic, "a");
    await cache.recordHit(topic, "a");
    await cache.recordHit(topic, "b");
    const [first, second] = await Promise.all([cache.topHits(topic, 5), cache.topHits(topic, 5)]);
    assert.deepEqual(first, ["a", "b"]);
    assert.deepEqual(second, ["a", "b"]);
  } finally {
    await cache.close();
  }
});
