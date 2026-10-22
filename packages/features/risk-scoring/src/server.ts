import { createServer, type ServerResponse } from "node:http";
import type { Address } from "@osstrace/core";
import { canonicalAddress, isChainId, isRealAddress, SUPPORTED_CHAINS } from "@osstrace/core";
// Chain wiring + label store are reused from Explorer's bootstrap, the same documented exception
// Visualizer and Tracer already take — one place to register a chain or a label dataset.
import { buildLabelStore, buildRegistryFromEnv, loadRootEnv } from "@osstrace/explorer/src/bootstrap.ts";
import type { TraceOptions } from "@osstrace/tracer/src/trace.ts";
import { assessRisk, clampRiskOptions } from "./risk.ts";

loadRootEnv();

// Its own variable: Explorer (PORT), Visualizer, Tracer and the rest all run side by side.
const PORT = Number(process.env["RISK_SCORING_PORT"] ?? 5305);

const registry = buildRegistryFromEnv();
const store = buildLabelStore();

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    // Permissive by design, same as Explorer/Visualizer/Tracer: a local dev tool called from a
    // local web UI on a different port, read-only, no auth. Tighten before any public deployment.
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body, null, 2));
}

function parseIntParam(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Same query names as Tracer's endpoints. Only sets a key the query actually provided (`exactOptionalPropertyTypes`). */
function optionsFromQuery(url: URL): Partial<TraceOptions> {
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

  const match = url.pathname.match(/^\/risk\/([^/]+)\/([^/]+)$/);
  if (!match) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const [, chainRaw, addressRaw] = match;
  if (!isChainId(chainRaw)) {
    sendJson(res, 400, { error: `unsupported chain "${chainRaw}" — supported: ${SUPPORTED_CHAINS.join(", ")}` });
    return;
  }
  const decoded = decodeURIComponent(addressRaw ?? "").trim();
  if (!isRealAddress(chainRaw, decoded)) {
    sendJson(res, 400, { error: `"${decoded}" is not a valid ${chainRaw} address` });
    return;
  }
  const address: Address = { chain: chainRaw, value: canonicalAddress(chainRaw, decoded) };
  const adapter = registry.get(address.chain);
  if (!adapter) {
    sendJson(res, 500, { error: `no adapter registered for chain "${address.chain}"` });
    return;
  }
  try {
    sendJson(res, 200, await assessRisk(address, adapter, store, clampRiskOptions(optionsFromQuery(url))));
  } catch (cause) {
    sendJson(res, 502, { error: cause instanceof Error ? cause.message : String(cause) });
  }
});

server.listen(PORT, () => {
  console.log(`Risk scoring API listening on http://localhost:${PORT}`);
  console.log(`Try: curl "http://localhost:${PORT}/risk/ethereum/<an Ethereum address>?maxHops=2"`);
});
