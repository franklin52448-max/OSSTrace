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
  /** The `limit` keys with the most recorded hits in `topic`, most-popular first. */
  topHits(topic: string, limit: number): Promise<string[]>;
}

/**
 * Zero-dependency default — works everywhere immediately, including every test in this repo.
 * Not shared across processes (each server/worker has its own), which is the real limitation:
 * the moment there's more than one API process, use RedisCache instead so they share one cache
 * and one popularity ranking. See packages/features/explorer/README.md.
 */
export class InMemoryCache implements Cache {
  readonly #entries = new Map<string, { value: string; expiresAt: number }>();
  readonly #counters = new Map<string, Map<string, number>>();

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
    const counts = this.#counters.get(topic) ?? new Map<string, number>();
    counts.set(key, (counts.get(key) ?? 0) + 1);
    this.#counters.set(topic, counts);
  }

  async topHits(topic: string, limit: number): Promise<string[]> {
    const counts = this.#counters.get(topic);
    if (!counts) return [];
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([key]) => key);
  }
}
