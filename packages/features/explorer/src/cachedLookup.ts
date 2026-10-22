import { addressKey, type Address, type Cache, type ChainAdapter, type LabelStore } from "@osstrace/core";
import { isCacheableReport, lookupAddress, type AddressReport } from "./lookup.ts";

/** Short on purpose — this is "recent activity" data, not something that needs to be perfectly live. */
const REPORT_TTL_SECONDS = 30;
export const LOOKUP_POPULARITY_TOPIC = "lookups";
/** The transaction limit used when a caller doesn't ask for one (the API's default `?limit=`). */
export const DEFAULT_TX_LIMIT = 25;

/**
 * The cache key for one report. It includes the transaction limit because a report fetched with
 * `limit=5` holds a genuinely different transaction list than one fetched with `limit=50` — the
 * two must never be served for each other.
 *
 * Popularity hits are deliberately *not* keyed by limit (they use plain `addressKey`): "which
 * addresses are in demand" is a per-address question. The background indexer refreshes hot
 * addresses at `DEFAULT_TX_LIMIT` through this same function, so its writes land on exactly the
 * key the API server's default lookups read.
 *
 * A paged lookup (`?before=`, ADR 0018) is a different transaction list again, so the cursor is
 * part of the key too. It's appended only when present: a lookup without one keeps exactly the
 * key it always had, which is the one the indexer warms.
 */
export function reportCacheKey(address: Address, txLimit: number, before?: string): string {
  const base = `${addressKey(address)}|limit=${txLimit}`;
  return before === undefined ? base : `${base}|before=${before}`;
}

/**
 * Wraps lookupAddress with a cache: every call records a popularity hit (so the background
 * indexer knows what's actually in demand), and a cache hit never touches the chain adapter at
 * all. This is the "instant loading" fix from SCALING-AND-COSTS.md — see that file (local only)
 * for the reasoning.
 *
 * Only the *chain* data (balance, transactions) is served from cache. Label/tags/entity are
 * re-read from the label store on every lookup, cache hit or not: they're cheap local reads, and
 * community labels change at human speed through moderation — a label confirmed or rejected a
 * second ago must not keep showing its old state for the rest of the cache TTL.
 */
export async function cachedLookupAddress(
  address: Address,
  adapter: ChainAdapter,
  store: LabelStore,
  cache: Cache,
  txLimit = DEFAULT_TX_LIMIT,
  before?: string,
): Promise<AddressReport> {
  await cache.recordHit(LOOKUP_POPULARITY_TOPIC, addressKey(address));

  const key = reportCacheKey(address, txLimit, before);
  const cached = await cache.get(key);
  if (cached) {
    const report = JSON.parse(cached) as AddressReport;
    const [label, tags, entity] = await Promise.all([store.getLabel(address), store.getTags(address), store.getEntity(address)]);
    return { ...report, label, tags, entity };
  }

  const report = await lookupAddress(address, adapter, store, txLimit, before);
  if (isCacheableReport(report)) await cache.set(key, JSON.stringify(report), REPORT_TTL_SECONDS);
  return report;
}
