import { createServer } from "node:http";
import { isSupportedChain, normalizeAddress, SUPPORTED_CHAINS } from "./address.ts";
import { buildCache, buildEventBus, buildLabelStore, buildRegistryFromEnv, loadRootEnv } from "./bootstrap.ts";
import { cachedLookupAddress, DEFAULT_TX_LIMIT } from "./cachedLookup.ts";
import { Indexer, indexerSettingsFromEnv } from "./indexing.ts";
import { attachStream, STREAM_PATH, StreamHub } from "./stream.ts";

loadRootEnv();

const PORT = Number(process.env["PORT"] ?? 5300);

const registry = buildRegistryFromEnv();
const store = buildLabelStore();
const cache = buildCache();
const bus = buildEventBus();

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json",
    // Permissive by design: this is a local dev tool meant to be called from a local web UI on
    // a different port. Tighten this before any public deployment — see README's "Known gaps."
    "access-control-allow-origin": "*",
  });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 400, { error: "no URL" });
    return;
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  const match = url.pathname.match(/^\/address\/([^/]+)\/([^/]+)$/);
  if (match) {
    const [, chainRaw, addressRaw] = match;
    if (!chainRaw || !addressRaw || !isSupportedChain(chainRaw)) {
      sendJson(res, 400, { error: `unsupported chain "${chainRaw}" — supported: ${SUPPORTED_CHAINS.join(", ")}` });
      return;
    }
    const adapter = registry.get(chainRaw);
    if (!adapter) {
      sendJson(res, 500, { error: `no adapter registered for chain "${chainRaw}"` });
      return;
    }
    const address = normalizeAddress(chainRaw, decodeURIComponent(addressRaw));
    try {
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? Number(limitParam) : DEFAULT_TX_LIMIT;
      const report = await cachedLookupAddress(address, adapter, store, cache, Number.isFinite(limit) ? limit : DEFAULT_TX_LIMIT);
      sendJson(res, 200, report);
    } catch (cause) {
      sendJson(res, 502, { error: cause instanceof Error ? cause.message : String(cause) });
    }
    return;
  }

  sendJson(res, 404, { error: "not found" });
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
  console.log(`Live updates: ws://localhost:${PORT}${STREAM_PATH}`);
  console.log(`Try: curl http://localhost:${PORT}/address/ethereum/0x0000000000000000000000000000000000000000`);
});
