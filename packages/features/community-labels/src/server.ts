import { createServer } from "node:http";
import { buildAccountService } from "@osstrace/accounts";
import { JsonFilePrivateLabelStore, PrivateLabelService, privateLabelsStorePath } from "@osstrace/private-labels";
import { createLabelSubmissionsHandler } from "./http.ts";
import { communityLabelsPath } from "./paths.ts";
import { LabelSubmissionService } from "./service.ts";
import type { PrivateLabelLookup } from "./share.ts";
import { JsonFileSubmissionStore } from "./store.ts";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch {
    // A malformed .env must not crash the process — fall through to defaults.
  }
}

// 5311: next to the accounts service (5310), clear of the 5302+ slots handed to worktree dev servers.
const PORT = Number(process.env["COMMUNITY_LABELS_PORT"] ?? 5311);

const allowedOrigins = (process.env["COMMUNITY_LABELS_ALLOWED_ORIGINS"] ?? "http://localhost:5301")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Same accounts file as the accounts server (ACCOUNTS_STORE_PATH), so a session issued there is
// valid here and a role granted there applies here on the next request.
const accounts = buildAccountService();

// "Share as Community label" (ADR 0017) reads the caller's own private label from the same file
// the private-labels server writes (PRIVATE_LABELS_STORE_PATH). Only `get` is handed over, so this
// process can read a user's own label (owner-scoped by their token) but never write that file.
const privateLabelService = new PrivateLabelService(accounts, new JsonFilePrivateLabelStore(privateLabelsStorePath()));
const privateLabels: PrivateLabelLookup = { get: (token, chain, address) => privateLabelService.get(token, chain, address) };

const service = new LabelSubmissionService(new JsonFileSubmissionStore(communityLabelsPath()), accounts, { privateLabels });
const handle = createLabelSubmissionsHandler(service, { allowedOrigins });

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
  console.log(`Community labels API listening on http://localhost:${PORT}`);
  console.log(`Submissions file: ${communityLabelsPath()}`);
});
