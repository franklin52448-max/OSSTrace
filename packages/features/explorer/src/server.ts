import { createServer } from "node:http";
import type { Address, ChainId } from "@opentrace/core";
import { buildCache, buildLabelStore, buildRegistryFromEnv, loadRootEnv } from "./bootstrap.ts";
import { cachedLookupAddress, DEFAULT_TX_LIMIT } from "./cachedLookup.ts";

loadRootEnv();

const PORT = Number(process.env["PORT"] ?? 5300);

const registry = buildRegistryFromEnv();
const store = buildLabelStore();
const cache = buildCache();

const SUPPORTED_CHAINS: readonly ChainId[] = ["ethereum", "solana"];

function isChainId(value: string): value is ChainId {
  return (SUPPORTED_CHAINS as readonly string[]).includes(value);
}

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json",
    // Permissive by design: this is a local dev tool meant to be called from a local web UI on
    // a different port. Tighten this before any public deployment — see README's "Known gaps."
    "access-control-allow-origin": "*",
  });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 400, { error: "no URL" });
    return;
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  const match = url.pathname.match(/^\/address\/([^/]+)\/([^/]+)$/);
  if (match) {
    const [, chainRaw, addressRaw] = match;
    if (!chainRaw || !addressRaw || !isChainId(chainRaw)) {
      sendJson(res, 400, { error: `unsupported chain "${chainRaw}" — supported: ${SUPPORTED_CHAINS.join(", ")}` });
      return;
    }
    const adapter = registry.get(chainRaw);
    if (!adapter) {
      sendJson(res, 500, { error: `no adapter registered for chain "${chainRaw}"` });
      return;
    }
    const addressValue = chainRaw === "ethereum" ? decodeURIComponent(addressRaw).toLowerCase() : decodeURIComponent(addressRaw);
    const address: Address = { chain: chainRaw, value: addressValue };
    try {
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? Number(limitParam) : DEFAULT_TX_LIMIT;
      const report = await cachedLookupAddress(address, adapter, store, cache, Number.isFinite(limit) ? limit : DEFAULT_TX_LIMIT);
      sendJson(res, 200, report);
    } catch (cause) {
      sendJson(res, 502, { error: cause instanceof Error ? cause.message : String(cause) });
    }
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`Explorer API listening on http://localhost:${PORT}`);
  console.log(`Try: curl http://localhost:${PORT}/address/ethereum/0x0000000000000000000000000000000000000000`);
});
