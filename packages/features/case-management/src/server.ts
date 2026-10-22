import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildAccountService } from "@osstrace/accounts";
import { createCasesHandler } from "./http.ts";
import { casesPath } from "./paths.ts";
import { CaseService } from "./service.ts";
import { JsonFileCaseStore } from "./store.ts";

const envPath = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch {
    // A malformed .env must not crash the process -- fall through to defaults.
  }
}

// 5314: next to accounts (5310), community-labels (5311), private-labels (5312) and bounties
// (5313) -- case management depends on accounts the same way those do.
const PORT = Number(process.env["CASES_PORT"] ?? 5314);

const allowedOrigins = (process.env["CASES_ALLOWED_ORIGINS"] || process.env["ACCOUNTS_ALLOWED_ORIGINS"] || "http://localhost:5301")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Same accounts file as the accounts server, so a session issued there is valid here too. This
// server only ever *reads* that file (authenticate() never writes), so the accounts store's
// one-writer assumption still holds.
const service = new CaseService(buildAccountService(), new JsonFileCaseStore(casesPath()));
const handle = createCasesHandler(service, { allowedOrigins });

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
  console.log(`Case management API listening on http://localhost:${PORT}`);
  console.log(`Cases file: ${casesPath()}`);
});
