// Named import, not default: under moduleResolution "nodenext", ioredis's CJS/ESM-interop
// typings resolve a default import to the whole module namespace rather than the Redis class
// itself (a known rough edge of its hand-maintained .d.ts under this resolution mode). The
// named `Redis` export doesn't have that ambiguity.
import { Redis } from "ioredis";
import type { Cache } from "@osstrace/core";

/**
 * Real Redis-backed Cache — use this once there's more than one API/worker process, so they
 * share one cache and one popularity ranking instead of each keeping their own in memory.
 * See packages/core/src/cache.ts for why caching and popularity-ranking share one interface.
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
    await this.#redis.zincrby(topic, 1, key);
  }

  async topHits(topic: string, limit: number): Promise<string[]> {
    return await this.#redis.zrevrange(topic, 0, limit - 1);
  }

  async close(): Promise<void> {
    await this.#redis.quit();
  }
}
