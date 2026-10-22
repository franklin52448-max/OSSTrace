import { createServer, type ServerResponse } from "node:http";
import type { Address, ChainId } from "@osstrace/core";
import { canonicalAddress, isRealAddress } from "@osstrace/core";
// Chain wiring + label store are reused from Explorer's bootstrap, same documented exception
// Visualizer already takes (see its README, "How it plugs in") — one place to register a chain.
import { buildLabelStore, buildRegistryFromEnv, loadRootEnv } from "@osstrace/explorer/src/bootstrap.ts";
import type { TraceFilters } from "./filters.ts";
import { buildTraceGraph, buildTracePath, clampTraceOptions, type TraceOptions } from "./trace.ts";

loadRootEnv();

// Not PORT or VISUALIZER_PORT: those belong to the Explorer and Visualizer APIs, all three run side by side.
const PORT = Number(process.env["TRACER_PORT"] ?? 5303);

const registry = buildRegistryFromEnv();
const store = buildLabelStore();

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
  const decoded = decodeURIComponent(addressRaw).trim();
  if (!isRealAddress(chainRaw, decoded)) {
    sendJson(res, 400, { error: `"${decoded}" is not a valid ${chainRaw} address` });
    return null;
  }
  return { chain: chainRaw, value: canonicalAddress(chainRaw, decoded) };
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

  const graphMatch = url.pathname.match(/^\/trace\/graph\/([^/]+)\/([^/]+)$/);
  if (graphMatch) {
    const [, chainRaw, addressRaw] = graphMatch;
    const address = resolveChainAndAddress(res, chainRaw, addressRaw);
    if (!address) return;
    const adapter = registry.get(address.chain);
    if (!adapter) {
      sendJson(res, 500, { error: `no adapter registered for chain "${address.chain}"` });
      return;
    }
    const opts = clampTraceOptions(traceOptionsFromQuery(url));
    try {
      const report = await buildTraceGraph(address, adapter, store, opts);
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
    const to = resolveChainAndAddress(res, chainRaw, url.searchParams.get("to") ?? undefined);
    if (!to) return;
    const adapter = registry.get(from.chain);
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
      const report = await buildTracePath(from, to, adapter, store, filters, opts);
      sendJson(res, 200, report);
    } catch (cause) {
      sendJson(res, 502, { error: cause instanceof Error ? cause.message : String(cause) });
    }
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`Tracer API listening on http://localhost:${PORT}`);
  console.log(`Try: curl "http://localhost:${PORT}/trace/graph/solana/<a Solana address>?maxHops=2"`);
  console.log(`Or:  curl "http://localhost:${PORT}/trace/path/solana?from=<A>&to=<B>&token=USDC&minAmount=100"`);
});
