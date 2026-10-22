import { createServer } from "node:http";
// Chain wiring + label store are reused from Explorer's bootstrap rather than duplicated, so a new
// chain (one line in explorer/src/registry.ts) or a new label file shows up here automatically.
// This is a deliberate, documented exception to "don't reach into another feature's internals" —
// see this package's README, "How it plugs in".
import { buildLabelStore, buildRegistryFromEnv, loadRootEnv } from "@osstrace/explorer/src/bootstrap.ts";
import { createVisualizerHandler } from "./http.ts";

loadRootEnv();

// Not PORT: the root .env's PORT belongs to the Explorer API, and both run side by side.
const PORT = Number(process.env["VISUALIZER_PORT"] ?? 5302);

const registry = buildRegistryFromEnv();
const store = buildLabelStore();

const handle = createVisualizerHandler({ registry, store });

const server = createServer((req, res) => {
  void handle(req, res);
});

server.listen(PORT, () => {
  console.log(`Visualizer API listening on http://localhost:${PORT}`);
  console.log(`Try: curl http://localhost:${PORT}/graph/solana/<a Solana address>`);
});
