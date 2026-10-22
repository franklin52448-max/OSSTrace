import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildAccountService } from "@osstrace/accounts";
import { createBountiesHandler } from "./http.ts";
import { bountiesPath } from "./paths.ts";
import { BountyService } from "./service.ts";
import { JsonFileBountyStore } from "./store.ts";

const envPath = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch {
    // A malformed .env must not crash the process -- fall through to defaults.
  }
}

// 5313: next to accounts (5310), private-labels (5312) and community-labels (5311) -- bounties
// depends on accounts the same way those do.
const PORT = Number(process.env["BOUNTIES_PORT"] ?? 5313);

const allowedOrigins = (process.env["BOUNTIES_ALLOWED_ORIGINS"] ?? process.env["ACCOUNTS_ALLOWED_ORIGINS"] ?? "http://localhost:5301")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Same accounts file as the accounts server, so a session issued there is valid here too.
const service = new BountyService(new JsonFileBountyStore(bountiesPath()), buildAccountService());
const handle = createBountiesHandler(service, { allowedOrigins });

const server = createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (await handle(req, res)) return;
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found", message: "not found" }));
});

server.listen(PORT, () => {
  console.log(`Bounties API listening on http://localhost:${PORT}`);
  console.log(`Bounties file: ${bountiesPath()}`);
});
