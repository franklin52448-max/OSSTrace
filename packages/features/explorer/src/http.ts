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

/**
 * Upper bound on a `?before=` cursor's length. Every cursor a chain adapter hands out is far
 * shorter (an Ethereum `block:txIndex:n:n`, a Solana signature of at most 88 characters); the
 * bound keeps an arbitrary string out of the cache key space.
 */
export const MAX_CURSOR_LENGTH = 128;
const CURSOR_CHARS = /^[A-Za-z0-9:]+$/;

/**
 * `?before=` → the cursor to pass to the chain adapter (ADR 0018), `undefined` when absent or
 * empty (the most recent page, exactly as without it), or `null` when it can't be any adapter's
 * cursor (wrong characters or too long) and the request should get a 400. Whether a well-formed
 * cursor is valid for its chain is the adapter's call; one it can't use comes back as
 * `transactions: { available: false, reason }`.
 */
export function parseBeforeCursor(raw: string | null): string | undefined | null {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (trimmed.length > MAX_CURSOR_LENGTH || !CURSOR_CHARS.test(trimmed)) return null;
  return trimmed;
}

export interface ExplorerDeps {
  registry: ReadonlyMap<ChainId, ChainAdapter>;
  store: LabelStore;
  cache: Cache;
  /**
   * Exact browser origins allowed to call this API (CORS), the same allowlist pattern as the
   * accounts API. Never `*`. A request from an allowed origin gets it reflected back; any other
   * origin gets no CORS header, so the browser blocks the page from reading the response.
   * Default: the web UI's dev server, `http://localhost:5301`. In `server.ts` this comes from
   * `EXPLORER_ALLOWED_ORIGINS`, falling back to `ACCOUNTS_ALLOWED_ORIGINS`.
   */
  allowedOrigins?: readonly string[];
}

/** The web UI's dev server (`packages/web/vite.config.ts`). */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = ["http://localhost:5301"];

function sendJson(res: ServerResponse, status: number, body: unknown, cors: Record<string, string>): void {
  res.writeHead(status, { "content-type": "application/json", ...cors });
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
  const allowedOrigins = new Set(deps.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);

  function corsHeaders(req: IncomingMessage): Record<string, string> {
    // `Vary: Origin` always: the response differs by Origin, so no cache may reuse one across origins.
    const headers: Record<string, string> = { vary: "Origin" };
    const origin = req.headers["origin"];
    if (typeof origin === "string" && allowedOrigins.has(origin)) {
      headers["access-control-allow-origin"] = origin;
      headers["access-control-allow-methods"] = "GET, OPTIONS";
    }
    return headers;
  }

  return async function handle(req, res) {
    const send = (status: number, body: unknown): void => sendJson(res, status, body, corsHeaders(req));
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "OPTIONS") {
        // Preflight. The Explorer's own GETs are "simple" requests that don't need one, but a
        // client adding a header would send one, and it should get a real answer, not a 404.
        res.writeHead(204, corsHeaders(req));
        res.end();
        return;
      }

      if (url.pathname === "/health") {
        send(200, { ok: true });
        return;
      }

      const match = url.pathname.match(/^\/address\/([^/]+)\/([^/]+)$/);
      if (!match) {
        send(404, { error: "not found" });
        return;
      }
      const [, chainRaw, addressRaw] = match;
      if (!chainRaw || !addressRaw || !isChainId(chainRaw)) {
        send(400, { error: `unsupported chain — supported: ${SUPPORTED_CHAINS.join(", ")}` });
        return;
      }
      let decoded: string;
      try {
        decoded = decodeURIComponent(addressRaw).trim();
      } catch {
        send(400, { error: "malformed URL encoding in the address" });
        return;
      }
      if (!isRealAddress(chainRaw, decoded)) {
        send(400, { error: `not a valid ${chainRaw} address` });
        return;
      }
      const adapter = deps.registry.get(chainRaw);
      if (!adapter) {
        send(500, { error: `no adapter registered for chain "${chainRaw}"` });
        return;
      }
      const address: Address = { chain: chainRaw, value: canonicalAddress(chainRaw, decoded) };
      const limit = parseTxLimit(url.searchParams.get("limit"));
      const before = parseBeforeCursor(url.searchParams.get("before"));
      if (before === null) {
        send(400, { error: "malformed ?before= cursor — pass transactions.nextCursor from a previous response unchanged" });
        return;
      }
      // A failed balance or transactions call is NOT a 502: it comes back inside a 200 report as
      // `{ available: false, reason }` on that one field, next to everything that did work
      // (ADR 0014). A 502 here now means only that the lookup as a whole failed — e.g. the label
      // store or the cache couldn't be read.
      try {
        send(200, await cachedLookupAddress(address, adapter, deps.store, deps.cache, limit, before));
      } catch (cause) {
        send(502, { error: cause instanceof Error ? cause.message : String(cause) });
      }
    } catch (cause) {
      // Last line of defence: an unexpected throw must become a response, never an unhandled
      // rejection that takes the process down for every other user.
      console.error("explorer: unhandled error", cause);
      if (!res.headersSent) send(500, { error: "internal error" });
      else res.end();
    }
  };
}
