import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildAccountService } from "@osstrace/accounts";
import { createDepositVerifier } from "./deposits.ts";
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

// ADR 0020: public addresses only -- this project never generates or holds the key behind either
// one. A chain left unset here just can't take deposits yet (checked and refused, not a crash).
// `exactOptionalPropertyTypes` means the key must be left out entirely, not set to undefined.
const ethereumWallet = process.env["BOUNTIES_RECEIVING_WALLET_ETHEREUM"];
const solanaWallet = process.env["BOUNTIES_RECEIVING_WALLET_SOLANA"];
const wallets = {
  ...(ethereumWallet ? { ethereum: ethereumWallet } : {}),
  ...(solanaWallet ? { solana: solanaWallet } : {}),
};
const deposits = createDepositVerifier({
  wallets,
  // Same public RPC endpoints every other feature already uses -- no new config, no API key.
  solanaRpcUrl: process.env["SOLANA_RPC_URL"] || "https://api.mainnet-beta.solana.com",
  ethereumRpcUrl: process.env["ETH_RPC_URL"] || "https://ethereum-rpc.publicnode.com",
});

// Same accounts file as the accounts server, so a session issued there is valid here too.
const service = new BountyService(new JsonFileBountyStore(bountiesPath()), buildAccountService(), { deposits });
const handle = createBountiesHandler(service, { allowedOrigins, wallets });

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
  const configured = Object.entries(wallets).filter(([, address]) => address);
  console.log(
    configured.length > 0
      ? `Deposits configured: ${configured.map(([chain, address]) => `${chain} → ${address}`).join(", ")}`
      : "Deposits: no receiving wallet configured on either chain yet (BOUNTIES_RECEIVING_WALLET_ETHEREUM / _SOLANA)",
  );
});
