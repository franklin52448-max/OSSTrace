import { createServer } from "node:http";
import { accountsStorePath, allowedOriginsFromEnv, buildAccountService, loadRootEnv } from "./bootstrap.ts";
import { createAccountsHandler } from "./http.ts";

loadRootEnv();

// 5310, not the next free number: 5300 is the Explorer, 5301 the web UI, and 5302+ are handed out
// to worktree dev servers (.env.agents) — the accounts service gets its own slot clear of those.
const PORT = Number(process.env["ACCOUNTS_PORT"] ?? 5310);

const handle = createAccountsHandler(buildAccountService(), { allowedOrigins: allowedOriginsFromEnv() });

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
  console.log(`Accounts API listening on http://localhost:${PORT}`);
  console.log(`Accounts file: ${accountsStorePath()}`);
});
