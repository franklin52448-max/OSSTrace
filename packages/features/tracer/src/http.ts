import type { IncomingMessage, ServerResponse } from "node:http";
import { canonicalAddress, isRealAddress, type Address, type ChainAdapter, type ChainId, type LabelStore } from "@osstrace/core";
import type { TraceFilters } from "./filters.ts";
import { buildTraceGraph, buildTracePath, clampTraceOptions, type BridgeTracing, type TraceOptions } from "./trace.ts";

const SUPPORTED_CHAINS: readonly ChainId[] = ["ethereum", "solana"];

function isChainId(value: string): value is ChainId {
  return (SUPPORTED_CHAINS as readonly string[]).includes(value);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    // Permissive by design, same as Explorer/Visualizer: a local dev tool called from a local web
    // UI on a different port. Tighten before any public deployment.
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body, null, 2));
}

function parseIntParam(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Only sets a key when the query actually provided it — `exactOptionalPropertyTypes` forbids `{ key: undefined }`. */
function traceOptionsFromQuery(url: URL): Partial<TraceOptions> {
  const opts: Partial<TraceOptions> = {};
  const maxHops = parseIntParam(url.searchParams.get("maxHops"));
  const breadth = parseIntParam(url.searchParams.get("breadth"));
  const txLimitPerNode = parseIntParam(url.searchParams.get("txLimit"));
  const maxAdapterCalls = parseIntParam(url.searchParams.get("maxCalls"));
  if (maxHops !== undefined) opts.maxHops = maxHops;
  if (breadth !== undefined) opts.breadth = breadth;
  if (txLimitPerNode !== undefined) opts.txLimitPerNode = txLimitPerNode;
  if (maxAdapterCalls !== undefined) opts.maxAdapterCalls = maxAdapterCalls;
  return opts;
}

function resolveChainAndAddress(
  res: ServerResponse,
  chainRaw: string | undefined,
  addressRaw: string | undefined,
): Address | null {
  if (!chainRaw || !addressRaw || !isChainId(chainRaw)) {
    sendJson(res, 400, { error: `unsupported chain "${chainRaw}" — supported: ${SUPPORTED_CHAINS.join(", ")}` });
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(addressRaw).trim();
  } catch {
    // A malformed `%` escape (e.g. "%E0%A4%A") throws outside any try/catch — the same crash
    // class the Explorer's http.ts fixes. Must become a 400, never an uncaught throw that takes
    // the whole server process down.
    sendJson(res, 400, { error: "malformed URL encoding in the address" });
    return null;
  }
  if (!isRealAddress(chainRaw, decoded)) {
    sendJson(res, 400, { error: `"${decoded}" is not a valid ${chainRaw} address` });
    return null;
  }
  return { chain: chainRaw, value: canonicalAddress(chainRaw, decoded) };
}

export interface TracerDeps {
  registry: ReadonlyMap<ChainId, ChainAdapter>;
  store: LabelStore;
  /** `undefined` if cross-chain bridge following isn't configured for this server at all. */
  wormhole?: BridgeTracing;
}

/**
 * The Tracer API's request handler, separate from `server.ts` (which only wires real dependencies
 * and listens) so it can be tested against a real HTTP server — same split Explorer uses in its
 * own `http.ts`, for the same reason: a malformed `%` escape in an address used to throw outside
 * any try/catch, crashing the whole server process for every other caller.
 */
export function createTracerHandler(deps: TracerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  /** `undefined` = stay on one chain (ADR 0008), a `BridgeTracing` = follow Wormhole hops, `null` = invalid value (already answered 400). */
  function bridgingFromQuery(res: ServerResponse, url: URL): BridgeTracing | undefined | null {
    const raw = url.searchParams.get("bridges");
    if (raw === null || raw === "" || raw === "none") return undefined;
    if (raw === "wormhole") {
      if (!deps.wormhole) {
        sendJson(res, 500, { error: "bridge following isn't configured on this server" });
        return null;
      }
      return deps.wormhole;
    }
    sendJson(res, 400, { error: `unsupported bridges value "${raw}" — supported: wormhole` });
    return null;
  }

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

      const graphMatch = url.pathname.match(/^\/trace\/graph\/([^/]+)\/([^/]+)$/);
      if (graphMatch) {
        const [, chainRaw, addressRaw] = graphMatch;
        const address = resolveChainAndAddress(res, chainRaw, addressRaw);
        if (!address) return;
        const adapter = deps.registry.get(address.chain);
        if (!adapter) {
          sendJson(res, 500, { error: `no adapter registered for chain "${address.chain}"` });
          return;
        }
        const bridging = bridgingFromQuery(res, url);
        if (bridging === null) return;
        const opts = clampTraceOptions(traceOptionsFromQuery(url));
        try {
          const report = await buildTraceGraph(address, adapter, deps.store, opts, bridging);
          sendJson(res, 200, report);
        } catch (cause) {
          sendJson(res, 502, { error: cause instanceof Error ? cause.message : String(cause) });
        }
        return;
      }

      const pathMatch = url.pathname.match(/^\/trace\/path\/([^/]+)$/);
      if (pathMatch) {
        const [, chainRaw] = pathMatch;
        const from = resolveChainAndAddress(res, chainRaw, url.searchParams.get("from") ?? undefined);
        if (!from) return;
        // `to` may be on another chain (ADR 0012); it defaults to the `from` chain.
        const to = resolveChainAndAddress(res, url.searchParams.get("toChain") ?? chainRaw, url.searchParams.get("to") ?? undefined);
        if (!to) return;
        const bridging = bridgingFromQuery(res, url);
        if (bridging === null) return;
        if (to.chain !== from.chain && bridging === undefined) {
          sendJson(res, 400, { error: `a path from ${from.chain} to ${to.chain} needs bridges=wormhole — without it no path can cross chains` });
          return;
        }
        const adapter = deps.registry.get(from.chain);
        if (!adapter) {
          sendJson(res, 500, { error: `no adapter registered for chain "${from.chain}"` });
          return;
        }
        const opts = clampTraceOptions(traceOptionsFromQuery(url));
        const token = url.searchParams.get("token");
        const minAmount = url.searchParams.get("minAmount");
        const sinceTimestamp = url.searchParams.get("since");
        const untilTimestamp = url.searchParams.get("until");
        const filters: TraceFilters = {
          ...(token !== null ? { token } : {}),
          ...(minAmount !== null ? { minAmount } : {}),
          ...(sinceTimestamp !== null ? { sinceTimestamp } : {}),
          ...(untilTimestamp !== null ? { untilTimestamp } : {}),
        };
        try {
          const report = await buildTracePath(from, to, adapter, deps.store, filters, opts, bridging);
          sendJson(res, 200, report);
        } catch (cause) {
          sendJson(res, 502, { error: cause instanceof Error ? cause.message : String(cause) });
        }
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (cause) {
      // Last line of defence: an unexpected throw must become a response, never an unhandled
      // promise rejection that takes the process down for every other caller.
      console.error("tracer: unhandled error", cause);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.end();
    }
  };
}
