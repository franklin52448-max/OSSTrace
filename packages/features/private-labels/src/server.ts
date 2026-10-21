import { createServer } from "node:http";
import { accountsStorePath, allowedOriginsFromEnv, buildPrivateLabelService, loadRootEnv, privateLabelsStorePath } from "./bootstrap.ts";
import { createPrivateLabelsHandler } from "./http.ts";

loadRootEnv();

// 5312: next to the accounts API (5310), clear of 5302+ which worktree dev servers use.
const PORT = Number(process.env["PRIVATE_LABELS_PORT"] ?? 5312);

const handle = createPrivateLabelsHandler(buildPrivateLabelService(), { allowedOrigins: allowedOriginsFromEnv() });

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
  console.log(`Private labels API listening on http://localhost:${PORT}`);
  console.log(`Private labels file: ${privateLabelsStorePath()}`);
  console.log(`Authenticating sessions against: ${accountsStorePath()}`);
});
