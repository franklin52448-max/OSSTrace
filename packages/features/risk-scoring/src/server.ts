import { createServer } from "node:http";
// Chain wiring + label store are reused from Explorer's bootstrap, the same documented exception
// Visualizer and Tracer already take — one place to register a chain or a label dataset.
import { buildLabelStore, buildRegistryFromEnv, loadRootEnv } from "@osstrace/explorer/src/bootstrap.ts";
import { createRiskScoringHandler } from "./http.ts";

loadRootEnv();

// Its own variable: Explorer (PORT), Visualizer, Tracer and the rest all run side by side.
const PORT = Number(process.env["RISK_SCORING_PORT"] ?? 5305);

const registry = buildRegistryFromEnv();
const store = buildLabelStore();

const handle = createRiskScoringHandler({ registry, store });

const server = createServer((req, res) => {
  void handle(req, res);
});

server.listen(PORT, () => {
  console.log(`Risk scoring API listening on http://localhost:${PORT}`);
  console.log(`Try: curl "http://localhost:${PORT}/risk/ethereum/<an Ethereum address>?maxHops=2"`);
});
