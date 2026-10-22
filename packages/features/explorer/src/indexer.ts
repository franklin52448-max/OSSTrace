import { buildCache, buildEventBus, buildLabelStore, buildRegistryFromEnv, loadRootEnv } from "./bootstrap.ts";
import { Indexer, indexerSettingsFromEnv } from "./indexing.ts";

/** The background indexer as its own process. All the logic lives in `indexing.ts`. */

loadRootEnv();

const { intervalMs, topN } = indexerSettingsFromEnv();

if (!process.env["REDIS_URL"]) {
  console.warn(
    "REDIS_URL is not set: this process has its own in-memory cache, popularity ranking and event bus, " +
      "so it can't warm the API server's cache or push live updates to its websocket clients. " +
      "Set REDIS_URL, or run the indexer inside the API process with EXPLORER_EMBEDDED_INDEXER=1.",
  );
}

const indexer = new Indexer({
  registry: buildRegistryFromEnv(),
  store: buildLabelStore(),
  cache: buildCache(),
  bus: buildEventBus(),
  intervalMs,
  topN,
  log: (line) => console.log(line),
});

console.log(`Indexer running: refreshing the top ${topN} looked-up addresses every ${intervalMs}ms.`);
indexer.start();
