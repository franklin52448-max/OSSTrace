// Named import, not default: under moduleResolution "nodenext", ioredis's CJS/ESM-interop
// typings resolve a default import to the whole module namespace rather than the Redis class
// itself (a known rough edge of its hand-maintained .d.ts under this resolution mode). The
// named `Redis` export doesn't have that ambiguity.
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { currentPopularityBucket, POPULARITY_BUCKET_COUNT, POPULARITY_WINDOW_MS, type Cache } from "@osstrace/core";

function bucketKey(topic: string, bucket: number): string {
  return `${topic}:bucket:${bucket}`;
}

/**
 * Real Redis-backed Cache — use this once there's more than one API/worker process, so they
 * share one cache and one popularity ranking instead of each keeping their own in memory.
 * See packages/core/src/cache.ts for why caching and popularity-ranking share one interface, and
 * for `POPULARITY_WINDOW_MS`/`POPULARITY_BUCKET_COUNT` — the same sliding window `InMemoryCache`
 * uses, so a deployment's ranking means the same thing whichever backend is configured.
 *
 * Hits land in one sorted set per time bucket (`topic:bucket:<n>`) instead of one ever-growing
 * sorted set per topic. Each bucket's own `EXPIRE` is set well past the window, so a bucket that
 * ages out of every window sum is reclaimed by Redis on its own — no separate decay/cleanup job
 * has to walk every tracked key. `topHits` sums only the buckets inside the current window via
 * `ZUNIONSTORE` into a short-lived scratch key, so a key with no activity in the last
 * `POPULARITY_WINDOW_MS` simply stops being summed, instead of a lifetime total that never goes
 * down.
 */
export class RedisCache implements Cache {
  readonly #redis: Redis;

  constructor(redisUrl: string) {
    this.#redis = new Redis(redisUrl);
  }

  async get(key: string): Promise<string | null> {
    return await this.#redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.#redis.set(key, value, "EX", ttlSeconds);
  }

  async recordHit(topic: string, key: string): Promise<void> {
    const bk = bucketKey(topic, currentPopularityBucket());
    await this.#redis.zincrby(bk, 1, key);
    // Outlive the window by a comfortable margin (2x) so the bucket survives until it's aged out
    // of every window sum that could still include it, then Redis reclaims it with no extra call.
    await this.#redis.expire(bk, Math.ceil((POPULARITY_WINDOW_MS * 2) / 1000));
  }

  async topHits(topic: string, limit: number): Promise<string[]> {
    const nowBucket = currentPopularityBucket();
    const bucketKeys: string[] = [];
    for (let i = 0; i < POPULARITY_BUCKET_COUNT; i++) bucketKeys.push(bucketKey(topic, nowBucket - i));

    // A unique scratch key per call: topHits can run concurrently (the API server and the
    // standalone indexer both call it), and two calls sharing one destination key would corrupt
    // each other's sum.
    const dest = `${topic}:window:${randomUUID()}`;
    // ZUNIONSTORE on a bucket key that doesn't exist (any bucket from before this process's
    // uptime, or one that's already aged out) just contributes nothing — never an error.
    await this.#redis.zunionstore(dest, bucketKeys.length, ...bucketKeys);
    await this.#redis.expire(dest, 10); // scratch key only, not part of the real ranking state
    const result = await this.#redis.zrevrange(dest, 0, limit - 1);
    await this.#redis.del(dest);
    return result;
  }

  async close(): Promise<void> {
    await this.#redis.quit();
  }
}
