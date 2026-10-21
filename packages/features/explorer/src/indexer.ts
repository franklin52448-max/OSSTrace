import type { Address, ChainId } from "@osstrace/core";
import { buildCache, buildLabelStore, buildRegistryFromEnv, loadRootEnv } from "./bootstrap.ts";
import { DEFAULT_TX_LIMIT, LOOKUP_POPULARITY_TOPIC, reportCacheKey } from "./cachedLookup.ts";
import { lookupAddress } from "./lookup.ts";

loadRootEnv();

const INTERVAL_MS = Number(process.env["INDEXER_INTERVAL_MS"] ?? 30_000);
const TOP_N = Number(process.env["INDEXER_TOP_N"] ?? 20);
/** Refreshed entries get a longer TTL than a normal cache write — the indexer's whole job is
 *  keeping these warm between refresh cycles, so they shouldn't expire mid-cycle. */
const REFRESH_TTL_SECONDS = Math.ceil((INTERVAL_MS / 1000) * 2);

function parseKey(key: string): Address | null {
  const sep = key.indexOf(":");
  if (sep === -1) return null;
  const chain = key.slice(0, sep) as ChainId;
  const value = key.slice(sep + 1);
  if (chain !== "ethereum" && chain !== "solana") return null;
  return { chain, value };
}

async function main(): Promise<void> {
  const registry = buildRegistryFromEnv();
  const store = buildLabelStore();
  const cache = buildCache();

  console.log(`Indexer running: refreshing the top ${TOP_N} looked-up addresses every ${INTERVAL_MS}ms.`);

  for (;;) {
    const hot = await cache.topHits(LOOKUP_POPULARITY_TOPIC, TOP_N);
    if (hot.length === 0) {
      console.log("Nothing looked up yet — nothing to refresh this cycle.");
    }
    for (const key of hot) {
      const address = parseKey(key);
      if (!address) continue;
      const adapter = registry.get(address.chain);
      if (!adapter) continue;
      try {
        // Popularity is ranked per address; the warmed report is the default-limit one, written
        // under the same limit-aware key the API server reads for a plain (no `?limit=`) lookup.
        const report = await lookupAddress(address, adapter, store, DEFAULT_TX_LIMIT);
        await cache.set(reportCacheKey(address, DEFAULT_TX_LIMIT), JSON.stringify(report), REFRESH_TTL_SECONDS);
        console.log(`refreshed ${key}`);
      } catch (cause) {
        console.error(`failed to refresh ${key}:`, cause instanceof Error ? cause.message : cause);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
