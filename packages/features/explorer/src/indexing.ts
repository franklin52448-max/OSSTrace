import { addressKey, type Address, type Cache, type ChainAdapter, type ChainId, type LabelStore, type TransactionSummary } from "@osstrace/core";
import { isSupportedChain } from "./address.ts";
import { DEFAULT_TX_LIMIT, LOOKUP_POPULARITY_TOPIC, reportCacheKey } from "./cachedLookup.ts";
import type { CycleCompletedEvent, IndexerEventBus } from "./events.ts";
import { isCacheableReport, lookupAddress } from "./lookup.ts";
import { diffTransactions } from "./txDiff.ts";

export interface IndexerOptions {
  registry: Map<ChainId, ChainAdapter>;
  store: LabelStore;
  cache: Cache;
  /** Where "new transaction" and "cycle completed" events go. Optional: without one, the indexer only warms the cache, exactly as before. */
  bus?: IndexerEventBus;
  intervalMs: number;
  topN: number;
  log?: (line: string) => void;
  now?: () => Date;
}

export function indexerSettingsFromEnv(): { intervalMs: number; topN: number } {
  return {
    intervalMs: Number(process.env["INDEXER_INTERVAL_MS"] ?? 30_000),
    topN: Number(process.env["INDEXER_TOP_N"] ?? 20),
  };
}

export function parseAddressKey(key: string): Address | null {
  const sep = key.indexOf(":");
  if (sep === -1) return null;
  const chain = key.slice(0, sep);
  const value = key.slice(sep + 1);
  if (!isSupportedChain(chain) || value === "") return null;
  return { chain, value };
}

/**
 * The background indexer: every `intervalMs`, refetch the `topN` most-looked-up addresses and
 * rewrite their cached reports so the API serves them instantly.
 *
 * Real-time streaming rides on exactly those fetches (ADR 0013). The indexer remembers the
 * transaction hashes from each address's previous successful fetch; when a refetch contains a hash
 * the previous one didn't, that real transaction is published as a `new_transactions` event. That
 * adds zero chain-adapter calls: it's a set diff over data this loop already fetched.
 *
 * Baselines are kept only for addresses in the current cycle's top-N, so memory is bounded by
 * `topN`, and an address that drops out and later comes back starts from a fresh baseline instead
 * of reporting everything that happened while it wasn't watched as if it had just happened.
 */
export class Indexer {
  readonly #opts: IndexerOptions;
  readonly #baselines = new Map<string, TransactionSummary[]>();
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<void> | null = null;
  #stopped = false;

  constructor(opts: IndexerOptions) {
    this.#opts = opts;
  }

  /** Refreshed entries outlive two cycles, so they never expire between refreshes. */
  get refreshTtlSeconds(): number {
    return Math.ceil((this.#opts.intervalMs / 1000) * 2);
  }

  /** How many addresses currently have a transaction baseline (bounded by `topN`). */
  get baselineCount(): number {
    return this.#baselines.size;
  }

  /** One full refresh pass. Tests call this directly instead of waiting on the timer. */
  async runCycle(): Promise<CycleCompletedEvent> {
    const { registry, store, cache, bus, topN, intervalMs } = this.#opts;
    const log = this.#opts.log ?? (() => {});
    const now = this.#opts.now ?? (() => new Date());

    const startedAt = now().getTime();
    const hot = await cache.topHits(LOOKUP_POPULARITY_TOPIC, topN);
    if (hot.length === 0) log("Nothing looked up yet — nothing to refresh this cycle.");

    const live: string[] = [];
    const notLive: { key: string; reason: string }[] = [];
    const seen = new Set<string>();

    for (const key of hot) {
      const address = parseAddressKey(key);
      if (!address) continue;
      const adapter = registry.get(address.chain);
      if (!adapter) continue;
      seen.add(key);
      try {
        // Popularity is ranked per address; the warmed report is the default-limit one, written
        // under the same limit-aware key the API server reads for a plain (no `?limit=`) lookup.
        const report = await lookupAddress(address, adapter, store, DEFAULT_TX_LIMIT);
        // A report with a failed balance call isn't written over a good cached one (ADR 0014);
        // its transactions are still diffed below, since they came back fine on their own.
        if (isCacheableReport(report)) {
          await cache.set(reportCacheKey(address, DEFAULT_TX_LIMIT), JSON.stringify(report), this.refreshTtlSeconds);
          log(`refreshed ${key}`);
        } else if (!report.balance.available) {
          log(`refreshed ${key} without caching it: balance unavailable (${report.balance.reason})`);
        }

        if (!report.transactions.available) {
          // Couldn't check this cycle: keep the old baseline, report nothing new, say why.
          notLive.push({ key, reason: report.transactions.reason });
          continue;
        }
        const current = report.transactions.transactions;
        const previous = this.#baselines.get(key) ?? null;
        this.#baselines.set(key, current);
        live.push(key);

        const diff = diffTransactions(previous, current, DEFAULT_TX_LIMIT);
        if (bus && diff.newTransactions.length > 0) {
          await bus.publish({
            type: "new_transactions",
            address,
            transactions: diff.newTransactions,
            windowOverflow: diff.windowOverflow,
            detectedAt: now().toISOString(),
          });
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        log(`failed to refresh ${key}: ${message}`);
        notLive.push({ key, reason: `the indexer's last refresh of this address failed: ${message}` });
      }
    }

    for (const key of [...this.#baselines.keys()]) {
      if (!seen.has(key)) this.#baselines.delete(key);
    }

    const completedAt = now();
    const cycle: CycleCompletedEvent = {
      type: "cycle_completed",
      live,
      notLive,
      topN,
      intervalMs,
      durationMs: completedAt.getTime() - startedAt,
      completedAt: completedAt.toISOString(),
    };
    if (bus) await bus.publish(cycle);
    return cycle;
  }

  /** Runs a cycle now, then one every `intervalMs` after the previous one finishes, until `stop()`. */
  start(): void {
    this.#stopped = false;
    const tick = (): void => {
      this.#running = this.runCycle()
        .then(() => undefined)
        .catch((err: unknown) => (this.#opts.log ?? console.error)(`indexer cycle failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => {
          this.#running = null;
          if (!this.#stopped) this.#timer = setTimeout(tick, this.#opts.intervalMs);
        });
    };
    tick();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#running;
  }
}
