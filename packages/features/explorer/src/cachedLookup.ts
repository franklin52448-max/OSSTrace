import { addressKey, type Address, type Cache, type ChainAdapter, type LabelStore } from "@opentrace/core";
import { lookupAddress, type AddressReport } from "./lookup.ts";

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
 */
export function reportCacheKey(address: Address, txLimit: number): string {
  return `${addressKey(address)}|limit=${txLimit}`;
}

/**
 * Wraps lookupAddress with a cache: every call records a popularity hit (so the background
 * indexer knows what's actually in demand), and a cache hit never touches the chain adapter at
 * all. This is the "instant loading" fix from SCALING-AND-COSTS.md — see that file (local only)
 * for the reasoning.
 */
export async function cachedLookupAddress(
  address: Address,
  adapter: ChainAdapter,
  store: LabelStore,
  cache: Cache,
  txLimit = DEFAULT_TX_LIMIT,
): Promise<AddressReport> {
  await cache.recordHit(LOOKUP_POPULARITY_TOPIC, addressKey(address));

  const key = reportCacheKey(address, txLimit);
  const cached = await cache.get(key);
  if (cached) {
    return JSON.parse(cached) as AddressReport;
  }

  const report = await lookupAddress(address, adapter, store, txLimit);
  await cache.set(key, JSON.stringify(report), REPORT_TTL_SECONDS);
  return report;
}
