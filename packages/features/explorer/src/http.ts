import type { IncomingMessage, ServerResponse } from "node:http";
import {
  canonicalAddress,
  isChainId,
  isRealAddress,
  SUPPORTED_CHAINS,
  type Address,
  type Cache,
  type ChainAdapter,
  type ChainId,
  type LabelStore,
} from "@osstrace/core";
import { cachedLookupAddress, DEFAULT_TX_LIMIT } from "./cachedLookup.ts";

/**
 * Upper bound on `?limit=`. Same value the Visualizer API uses. A limit goes straight to the chain
 * adapters (Etherscan `offset`, Solana `getSignaturesForAddress` + one batched `getTransaction`
 * per signature), and every distinct limit is its own cache entry, so it has to be bounded.
 */
export const MAX_TX_LIMIT = 100;

/**
 * `?limit=` → a whole number in [1, MAX_TX_LIMIT]. Absent, non-numeric, zero or negative values
 * fall back to the default. Fractions are truncated and anything larger is capped, never passed
 * through as-is. (A negative limit used to reach Ethereum's `mergeHistory` as `slice(0, -n)`.)
 */
export function parseTxLimit(raw: string | null): number {
  if (raw === null || raw.trim() === "") return DEFAULT_TX_LIMIT;
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_TX_LIMIT;
  return Math.min(n, MAX_TX_LIMIT);
}

export interface ExplorerDeps {
  registry: ReadonlyMap<ChainId, ChainAdapter>;
  store: LabelStore;
  cache: Cache;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    // Permissive by design: this is a local dev tool meant to be called from a local web UI on
    // a different port. Tighten this before any public deployment — see README's "Known gaps."
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body, null, 2));
}

/**
 * The Explorer API's request handler, separate from `server.ts` (which only wires real
 * dependencies and listens) so it can be tested against a real HTTP server.
 *
 * Every request is answered. Bad input gets a 400 before anything reaches a chain adapter or the
 * popularity ranking: a malformed `%` escape in the path, an unsupported chain, or an address that
 * isn't well-formed for its chain. A malformed escape used to throw outside any try/catch, which
 * crashed the whole server process.
 */
export function createExplorerHandler(deps: ExplorerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async function handle(req, res) {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      const match = url.pathname.match(/^\/address\/([^/]+)\/([^/]+)$/);
      if (!match) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      const [, chainRaw, addressRaw] = match;
      if (!chainRaw || !addressRaw || !isChainId(chainRaw)) {
        sendJson(res, 400, { error: `unsupported chain — supported: ${SUPPORTED_CHAINS.join(", ")}` });
        return;
      }
      let decoded: string;
      try {
        decoded = decodeURIComponent(addressRaw).trim();
      } catch {
        sendJson(res, 400, { error: "malformed URL encoding in the address" });
        return;
      }
      if (!isRealAddress(chainRaw, decoded)) {
        sendJson(res, 400, { error: `not a valid ${chainRaw} address` });
        return;
      }
      const adapter = deps.registry.get(chainRaw);
      if (!adapter) {
        sendJson(res, 500, { error: `no adapter registered for chain "${chainRaw}"` });
        return;
      }
      const address: Address = { chain: chainRaw, value: canonicalAddress(chainRaw, decoded) };
      const limit = parseTxLimit(url.searchParams.get("limit"));
      // A failed balance or transactions call is NOT a 502: it comes back inside a 200 report as
      // `{ available: false, reason }` on that one field, next to everything that did work
      // (ADR 0014). A 502 here now means only that the lookup as a whole failed — e.g. the label
      // store or the cache couldn't be read.
      try {
        sendJson(res, 200, await cachedLookupAddress(address, adapter, deps.store, deps.cache, limit));
      } catch (cause) {
        sendJson(res, 502, { error: cause instanceof Error ? cause.message : String(cause) });
      }
    } catch (cause) {
      // Last line of defence: an unexpected throw must become a response, never an unhandled
      // rejection that takes the process down for every other user.
      console.error("explorer: unhandled error", cause);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.end();
    }
  };
}
