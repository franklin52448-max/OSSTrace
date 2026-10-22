import { createServer } from "node:http";
import { allowedOriginsFromEnv, buildCache, buildEventBus, buildLabelStore, buildRegistryFromEnv, loadRootEnv } from "./bootstrap.ts";
import { createExplorerHandler } from "./http.ts";
import { Indexer, indexerSettingsFromEnv } from "./indexing.ts";
import { attachStream, STREAM_PATH, StreamHub } from "./stream.ts";

loadRootEnv();

const PORT = Number(process.env["PORT"] ?? 5300);

const registry = buildRegistryFromEnv();
const store = buildLabelStore();
const cache = buildCache();
const bus = buildEventBus();

const allowedOrigins = allowedOriginsFromEnv();
const handle = createExplorerHandler({ registry, store, cache, allowedOrigins });

const server = createServer((req, res) => {
  void handle(req, res);
});

// Real-time streaming (ADR 0013): a websocket on this same server, relaying what the indexer finds.
const hub = await StreamHub.create(bus);
attachStream(server, hub);

// Optional: run the background indexer inside this process instead of as its own. The same
// indexer, same RPC cost — just sharing this process's cache and event bus, which is what makes
// live pushes work without Redis. With REDIS_URL set, the separate `npm run dev:indexer` process
// is the documented setup; don't run both, or every address is refetched twice per interval.
if (process.env["EXPLORER_EMBEDDED_INDEXER"] === "1") {
  const { intervalMs, topN } = indexerSettingsFromEnv();
  new Indexer({ registry, store, cache, bus, intervalMs, topN, log: (line) => console.log(`[indexer] ${line}`) }).start();
  console.log(`Embedded indexer: refreshing the top ${topN} looked-up addresses every ${intervalMs}ms.`);
}

server.listen(PORT, () => {
  console.log(`Explorer API listening on http://localhost:${PORT}`);
  console.log(`Browser origins allowed (CORS): ${allowedOrigins.join(", ")}`);
  console.log(`Live updates: ws://localhost:${PORT}${STREAM_PATH}`);
  console.log(`Try: curl http://localhost:${PORT}/address/ethereum/0x0000000000000000000000000000000000000000`);
});
