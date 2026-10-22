import type { IncomingMessage, ServerResponse } from "node:http";
import type { Address, ChainAdapter, ChainId, LabelStore } from "@osstrace/core";
import { canonicalAddress, isRealAddress } from "./addressFormat.ts";
import { buildGraph } from "./graph.ts";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
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

export interface VisualizerDeps {
  registry: ReadonlyMap<ChainId, ChainAdapter>;
  store: LabelStore;
}

/**
 * The Visualizer API's request handler, separate from `server.ts` (which only wires real
 * dependencies and listens) so it can be tested against a real HTTP server — same split Explorer
 * uses in its own `http.ts`, for the same reason: a malformed `%` escape in the address used to
 * throw outside any try/catch, crashing the whole server process for every other caller.
 */
export function createVisualizerHandler(deps: VisualizerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async function handle(req, res) {
    try {
      if (!req.url) {
        sendJson(res, 400, { error: "no URL" });
        return;
      }
      const url = new URL(req.url, "http://localhost");

      if (url.pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      const match = url.pathname.match(/^\/graph\/([^/]+)\/([^/]+)$/);
      if (!match) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      const [, chainRaw, addressRaw] = match;
      if (!chainRaw || !addressRaw || !isChainId(chainRaw)) {
        sendJson(res, 400, { error: `unsupported chain "${chainRaw}" — supported: ${SUPPORTED_CHAINS.join(", ")}` });
        return;
      }
      const adapter = deps.registry.get(chainRaw);
      if (!adapter) {
        sendJson(res, 500, { error: `no adapter registered for chain "${chainRaw}"` });
        return;
      }
      let decoded: string;
      try {
        decoded = decodeURIComponent(addressRaw).trim();
      } catch {
        // A malformed `%` escape (e.g. "%E0%A4%A") throws outside any try/catch — the same crash
        // class the Explorer's http.ts fixes. Must become a 400, never an uncaught throw.
        sendJson(res, 400, { error: "malformed URL encoding in the address" });
        return;
      }
      if (!isRealAddress(chainRaw, decoded)) {
        sendJson(res, 400, { error: `"${decoded}" is not a valid ${chainRaw} address` });
        return;
      }
      const address: Address = { chain: chainRaw, value: canonicalAddress(chainRaw, decoded) };
      try {
        const report = await buildGraph(address, adapter, deps.store, parseLimit(url.searchParams.get("limit")));
        sendJson(res, 200, report);
      } catch (cause) {
        sendJson(res, 502, { error: cause instanceof Error ? cause.message : String(cause) });
      }
    } catch (cause) {
      // Last line of defence: an unexpected throw must become a response, never an unhandled
      // promise rejection that takes the process down for every other caller.
      console.error("visualizer: unhandled error", cause);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.end();
    }
  };
}
