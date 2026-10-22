import { createServer } from "node:http";
// Chain wiring + label store are reused from Explorer's bootstrap, same documented exception
// Visualizer already takes (see its README, "How it plugs in") — one place to register a chain.
import { buildLabelStore, buildRegistryFromEnv, loadRootEnv } from "@osstrace/explorer/src/bootstrap.ts";
import { DEFAULT_WORMHOLESCAN_API_URL, WormholescanResolver } from "./bridges/wormhole.ts";
import { createTracerHandler } from "./http.ts";
import type { BridgeTracing } from "./trace.ts";

loadRootEnv();

// Not PORT or VISUALIZER_PORT: those belong to the Explorer and Visualizer APIs, all three run side by side.
const PORT = Number(process.env["TRACER_PORT"] ?? 5303);

const registry = buildRegistryFromEnv();
const store = buildLabelStore();

// Opt-in per request with ?bridges=wormhole (ADR 0012). Public API, no key needed.
const wormhole: BridgeTracing = {
  resolver: new WormholescanResolver({ baseUrl: process.env["WORMHOLESCAN_API_URL"] || DEFAULT_WORMHOLESCAN_API_URL }),
  adapters: registry,
};

const handle = createTracerHandler({ registry, store, wormhole });

const server = createServer((req, res) => {
  void handle(req, res);
});

server.listen(PORT, () => {
  console.log(`Tracer API listening on http://localhost:${PORT}`);
  console.log(`Try: curl "http://localhost:${PORT}/trace/graph/solana/<a Solana address>?maxHops=2"`);
  console.log(`Or:  curl "http://localhost:${PORT}/trace/path/solana?from=<A>&to=<B>&token=USDC&minAmount=100"`);
  console.log(`Cross-chain (Wormhole): add &bridges=wormhole, and &toChain=ethereum|solana on /trace/path`);
});
