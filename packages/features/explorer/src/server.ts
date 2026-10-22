import { createServer } from "node:http";
import { buildCache, buildLabelStore, buildRegistryFromEnv, loadRootEnv } from "./bootstrap.ts";
import { createExplorerHandler } from "./http.ts";

loadRootEnv();

const PORT = Number(process.env["PORT"] ?? 5300);

const handle = createExplorerHandler({
  registry: buildRegistryFromEnv(),
  store: buildLabelStore(),
  cache: buildCache(),
});

const server = createServer((req, res) => {
  void handle(req, res);
});

server.listen(PORT, () => {
  console.log(`Explorer API listening on http://localhost:${PORT}`);
  console.log(`Try: curl http://localhost:${PORT}/address/ethereum/0x0000000000000000000000000000000000000000`);
});
