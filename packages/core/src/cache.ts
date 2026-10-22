/**
 * A small key-value cache + popularity-ranking interface. Both concerns share one interface
 * because they share one natural backend: Redis's string GET/SET-with-expiry covers the cache
 * side, and its sorted sets (ZINCRBY/ZREVRANGE) cover "what's being looked up the most" directly
 * — see RedisCache in packages/features/explorer. No separate storage mechanism needed.
 */
export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Increments a popularity counter for `key` within `topic` (e.g. topic "lookups"). */
  recordHit(topic: string, key: string): Promise<void>;
  /** The `limit` keys with the most recorded hits in `topic` *within the popularity window below*, most-popular first. */
  topHits(topic: string, limit: number): Promise<string[]>;
}

/**
 * Popularity decays on a real sliding window, not forever: a hit older than
 * `POPULARITY_WINDOW_MS` stops counting toward "most looked up", instead of a counter that only
 * ever grows for as long as the process (or the Redis instance) stays up. Every `Cache`
 * implementation buckets hits into `POPULARITY_BUCKET_MS`-wide buckets and sums only the buckets
 * inside the window — old buckets age out on their own (and, for Redis, expire on their own),
 * rather than needing an explicit decay pass that touches every tracked key.
 *
 * 24 one-hour buckets: "most looked up in the last day" is the ranking the background indexer
 * (`INDEXER_TOP_N`) actually wants to act on — a address that was hot last month but is quiet now
 * shouldn't still occupy a warm-cache slot a month later.
 */
export const POPULARITY_BUCKET_MS = 60 * 60 * 1000;
export const POPULARITY_WINDOW_MS = 24 * POPULARITY_BUCKET_MS;
export const POPULARITY_BUCKET_COUNT = Math.ceil(POPULARITY_WINDOW_MS / POPULARITY_BUCKET_MS);

/** The bucket index "now" falls into — shared by every `Cache` implementation so they age out hits at the same rate. */
export function currentPopularityBucket(): number {
  return Math.floor(Date.now() / POPULARITY_BUCKET_MS);
}

/** The oldest bucket index still inside the window as of `nowBucket`. Anything older is out of scope. */
function oldestBucketInWindow(nowBucket: number): number {
  return nowBucket - POPULARITY_BUCKET_COUNT + 1;
}

/**
 * Zero-dependency default — works everywhere immediately, including every test in this repo.
 * Not shared across processes (each server/worker has its own), which is the real limitation:
 * the moment there's more than one API process, use RedisCache instead so they share one cache
 * and one popularity ranking. See packages/features/explorer/README.md.
 *
 * Two independent sources of unbounded growth, both fixed for real rather than left to the OS to
 * eventually OOM-kill the process on a long-lived deployment:
 *
 * 1. A cache entry past its TTL used to sit in `#entries` forever unless something happened to
 *    `get()` that exact key again. A periodic sweep (`sweepIntervalMs`, default 60s) now actively
 *    removes expired entries on a timer, not just lazily on read.
 * 2. A popularity counter used to only ever go up, for the lifetime of the process — see
 *    `POPULARITY_WINDOW_MS` above. Hits are now bucketed by time, and buckets outside the window
 *    are pruned on every `recordHit`/`topHits` call, so a key nobody has looked up in the last
 *    day stops taking up space in `#counters` at all, not just stops ranking.
 */
export class InMemoryCache implements Cache {
  readonly #entries = new Map<string, { value: string; expiresAt: number }>();
  // topic -> key -> bucket index -> hit count within that bucket.
  readonly #counters = new Map<string, Map<string, Map<number, number>>>();
  readonly #sweep: ReturnType<typeof setInterval>;

  constructor(sweepIntervalMs = 60_000) {
    this.#sweep = setInterval(() => this.#sweepExpiredEntries(), sweepIntervalMs);
    // Never keep a process alive just for this timer — every caller in this repo is either a
    // short-lived test or a server that's already listening on its own socket.
    this.#sweep.unref?.();
  }

  async get(key: string): Promise<string | null> {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.#entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.#entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async recordHit(topic: string, key: string): Promise<void> {
    const nowBucket = currentPopularityBucket();
    const byKey = this.#counters.get(topic) ?? new Map<string, Map<number, number>>();
    const buckets = byKey.get(key) ?? new Map<number, number>();
    buckets.set(nowBucket, (buckets.get(nowBucket) ?? 0) + 1);
    pruneOldBuckets(buckets, nowBucket);
    byKey.set(key, buckets);
    this.#counters.set(topic, byKey);
  }

  async topHits(topic: string, limit: number): Promise<string[]> {
    const byKey = this.#counters.get(topic);
    if (!byKey) return [];
    const nowBucket = currentPopularityBucket();
    const scored: Array<[string, number]> = [];
    for (const [key, buckets] of byKey) {
      pruneOldBuckets(buckets, nowBucket);
      if (buckets.size === 0) {
        byKey.delete(key);
        continue;
      }
      let total = 0;
      for (const count of buckets.values()) total += count;
      scored.push([key, total]);
    }
    if (byKey.size === 0) this.#counters.delete(topic);
    return scored
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([key]) => key);
  }

  #sweepExpiredEntries(): void {
    const now = Date.now();
    for (const [key, entry] of this.#entries) {
      if (now > entry.expiresAt) this.#entries.delete(key);
    }
  }

  /** Stops the sweep timer. Not part of `Cache` — only a long-lived owner needs this; a short test doesn't. */
  close(): void {
    clearInterval(this.#sweep);
  }

  /** Live entry count, expired-or-not — not part of `Cache`. Proves the sweep is actually shrinking the map, and useful as a debug/metrics number for a long-lived process. */
  get size(): number {
    return this.#entries.size;
  }
}

function pruneOldBuckets(buckets: Map<number, number>, nowBucket: number): void {
  const oldest = oldestBucketInWindow(nowBucket);
  for (const bucket of buckets.keys()) {
    if (bucket < oldest) buckets.delete(bucket);
  }
}
