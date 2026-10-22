import { createServer } from "node:http";
import { buildAccountService } from "@osstrace/accounts";
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

// The HTTP API's own CORS allowlist (ADR 0014/0018's explorer-gaps work) — EXPLORER_ALLOWED_ORIGINS,
// falling back to ACCOUNTS_ALLOWED_ORIGINS, then a local-dev default. Deliberately a separate list
// from the websocket's below: a public, read-only GET is a different trust decision than opening a
// live, authenticated stream.
const httpAllowedOrigins = allowedOriginsFromEnv();
const handle = createExplorerHandler({ registry, store, cache, allowedOrigins: httpAllowedOrigins });

const server = createServer((req, res) => {
  void handle(req, res);
});

// Real-time streaming (ADR 0013, hardened in §6): a websocket on this same server, relaying what
// the indexer finds. Sessions are checked against the same accounts file as the accounts server,
// so a token issued there works here. Allowed browser origins fall back to the accounts server's
// list, like bounties — but kept as its own env var, since who may open a live authenticated
// stream is a stricter decision than who may call the public read-only HTTP API above.
const streamAllowedOrigins = (process.env["EXPLORER_STREAM_ALLOWED_ORIGINS"] ?? process.env["ACCOUNTS_ALLOWED_ORIGINS"] ?? "http://localhost:5301")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const hub = await StreamHub.create(bus, { accounts: buildAccountService() });
attachStream(server, hub, { allowedOrigins: streamAllowedOrigins });

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
  console.log(`Browser origins allowed (CORS, HTTP API): ${httpAllowedOrigins.join(", ")}`);
  console.log(`Browser origins allowed (live stream): ${streamAllowedOrigins.join(", ")}`);
  console.log(`Live updates: ws://localhost:${PORT}${STREAM_PATH}`);
  console.log(`Try: curl http://localhost:${PORT}/address/ethereum/0x0000000000000000000000000000000000000000`);
});
