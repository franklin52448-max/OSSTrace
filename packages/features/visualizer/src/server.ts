import { createServer, type ServerResponse } from "node:http";
import type { Address, ChainId } from "@opentrace/core";
// Chain wiring + label store are reused from Explorer's bootstrap rather than duplicated, so a new
// chain (one line in explorer/src/registry.ts) or a new label file shows up here automatically.
// This is a deliberate, documented exception to "don't reach into another feature's internals" —
// see this package's README, "How it plugs in".
import { buildLabelStore, buildRegistryFromEnv, loadRootEnv } from "@opentrace/explorer/src/bootstrap.ts";
import { canonicalAddress, isRealAddress } from "./addressFormat.ts";
import { buildGraph } from "./graph.ts";

loadRootEnv();

// Not PORT: the root .env's PORT belongs to the Explorer API, and both run side by side.
const PORT = Number(process.env["VISUALIZER_PORT"] ?? 5302);
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const registry = buildRegistryFromEnv();
const store = buildLabelStore();

const SUPPORTED_CHAINS: readonly ChainId[] = ["ethereum", "solana"];

function isChainId(value: string): value is ChainId {
  return (SUPPORTED_CHAINS as readonly string[]).includes(value);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    // Permissive by design, same as Explorer: a local dev tool called from a local web UI on a
    // different port. Tighten before any public deployment — see README's "What's not built yet".
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body, null, 2));
}

function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
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

  const match = url.pathname.match(/^\/graph\/([^/]+)\/([^/]+)$/);
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
    const decoded = decodeURIComponent(addressRaw).trim();
    if (!isRealAddress(chainRaw, decoded)) {
      sendJson(res, 400, { error: `"${decoded}" is not a valid ${chainRaw} address` });
      return;
    }
    const address: Address = { chain: chainRaw, value: canonicalAddress(chainRaw, decoded) };
    try {
      const report = await buildGraph(address, adapter, store, parseLimit(url.searchParams.get("limit")));
      sendJson(res, 200, report);
    } catch (cause) {
      sendJson(res, 502, { error: cause instanceof Error ? cause.message : String(cause) });
    }
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`Visualizer API listening on http://localhost:${PORT}`);
  console.log(`Try: curl http://localhost:${PORT}/graph/solana/<a Solana address>`);
});
