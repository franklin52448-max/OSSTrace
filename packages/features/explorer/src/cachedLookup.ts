import { addressKey, type Address, type Cache, type ChainAdapter, type LabelStore } from "@opentrace/core";
import { lookupAddress, type AddressReport } from "./lookup.ts";

/** Short on purpose — this is "recent activity" data, not something that needs to be perfectly live. */
const REPORT_TTL_SECONDS = 30;
export const LOOKUP_POPULARITY_TOPIC = "lookups";

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
  txLimit = 25,
): Promise<AddressReport> {
  const key = addressKey(address);
  await cache.recordHit(LOOKUP_POPULARITY_TOPIC, key);

  const cached = await cache.get(key);
  if (cached) {
    return JSON.parse(cached) as AddressReport;
  }

  const report = await lookupAddress(address, adapter, store, txLimit);
  await cache.set(key, JSON.stringify(report), REPORT_TTL_SECONDS);
  return report;
}
