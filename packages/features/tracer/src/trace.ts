import type { Address, ChainAdapter, Entity, Label, LabelStore, Tag } from "@osstrace/core";
import { canonicalAddress } from "@osstrace/core";
import { deriveGraph, type GraphEdge } from "@osstrace/visualizer/src/graph.ts";
import { edgeMatchesFilters, type TraceFilters } from "./filters.ts";

/**
 * Bounds on every trace request. `maxAdapterCalls` is the real circuit breaker — `maxHops` and
 * `breadth` describe the *shape* of the search, but a popular address's own one-hop fan-out can
 * still blow through any reasonable call budget, so every expansion step checks the budget first
 * and the result always says honestly whether it was hit. See ADR 0008.
 */
export interface TraceOptions {
  /** How many hops out from the start address to search. 1-3. */
  maxHops: number;
  /** How many of a node's most-recently-active distinct counterparties to expand through. 1-10. */
  breadth: number;
  /** Transactions fetched per node (passed straight to `ChainAdapter.getRecentTransactions`). */
  txLimitPerNode: number;
  /** Hard cap on total `getRecentTransactions` calls for one request, regardless of hops/breadth. */
  maxAdapterCalls: number;
}

export const DEFAULT_TRACE_OPTIONS: TraceOptions = { maxHops: 2, breadth: 5, txLimitPerNode: 10, maxAdapterCalls: 40 };

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : Math.trunc(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** Clamps user-supplied options into a safe range instead of trusting query-string input directly. */
export function clampTraceOptions(opts: Partial<TraceOptions>): TraceOptions {
  return {
    maxHops: clampInt(opts.maxHops, DEFAULT_TRACE_OPTIONS.maxHops, 1, 3),
    breadth: clampInt(opts.breadth, DEFAULT_TRACE_OPTIONS.breadth, 1, 10),
    txLimitPerNode: clampInt(opts.txLimitPerNode, DEFAULT_TRACE_OPTIONS.txLimitPerNode, 1, 50),
    maxAdapterCalls: clampInt(opts.maxAdapterCalls, DEFAULT_TRACE_OPTIONS.maxAdapterCalls, 1, 100),
  };
}

/** One real fetch + decode of a single node's edges. `null` means "couldn't check" (never "no edges"). */
async function expandNode(address: Address, adapter: ChainAdapter, txLimit: number): Promise<GraphEdge[] | null> {
  const result = await adapter.getRecentTransactions(address.value, txLimit);
  if (!result.available) return null;
  return deriveGraph(address, result.transactions).edges;
}

function edgeKey(edge: GraphEdge): string {
  const [a, b] = [edge.source, edge.target].sort();
  return `${edge.hash}|${a}|${b}|${edge.kind}|${edge.token?.address ?? ""}`;
}

function neighborOf(edge: GraphEdge, nodeId: string): string {
  return edge.source === nodeId ? edge.target : edge.source;
}

/** Distinct neighbors of `nodeId` among `edges`, most-recently-active first. */
function rankNeighbors(edges: readonly GraphEdge[], nodeId: string): string[] {
  const latest = new Map<string, number>();
  for (const edge of edges) {
    const neighbor = neighborOf(edge, nodeId);
    const t = Date.parse(edge.timestamp);
    const prev = latest.get(neighbor);
    if (prev === undefined || t > prev) latest.set(neighbor, t);
  }
  return [...latest.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

export type FrontierReason = "depth-cap" | "breadth-cap" | "budget-exhausted" | "unavailable";

/** A node this trace reached but did not expand further, and honestly why — never implied to mean "no more connections." */
export interface FrontierNode {
  id: string;
  reason: FrontierReason;
}

export interface TraceGraphResult {
  centerId: string;
  edges: GraphEdge[];
  /** Node ids whose own transactions were actually fetched. */
  expandedIds: string[];
  frontier: FrontierNode[];
  adapterCallsUsed: number;
  /** True if `maxAdapterCalls` was hit before the configured `maxHops`/`breadth` was fully explored. */
  budgetExhausted: boolean;
}

/**
 * Expands a graph outward from `center` up to `opts.maxHops`, keeping every real edge it finds
 * (never dropped just because a node wasn't expanded further) but only recursing into each node's
 * `opts.breadth` most-recently-active distinct counterparties — "most recent" because mixing a
 * native amount and a token amount into one ranking would mean inventing an exchange rate (see
 * `filters.ts`), and recency is a real, well-defined order that needs none.
 */
export async function traceGraph(center: Address, adapter: ChainAdapter, opts: TraceOptions): Promise<TraceGraphResult> {
  const centerId = canonicalAddress(center.chain, center.value);
  const visited = new Set<string>([centerId]);
  const edgeSeen = new Set<string>();
  const edges: GraphEdge[] = [];
  const frontier = new Map<string, FrontierReason>();
  const expandedIds: string[] = [];
  let adapterCalls = 0;
  let budgetExhausted = false;

  let currentLevel = [centerId];
  for (let hop = 0; hop < opts.maxHops && currentLevel.length > 0; hop++) {
    const nextLevel: string[] = [];
    for (const nodeId of currentLevel) {
      if (adapterCalls >= opts.maxAdapterCalls) {
        frontier.set(nodeId, "budget-exhausted");
        budgetExhausted = true;
        continue;
      }
      adapterCalls++;
      const nodeEdges = await expandNode({ chain: center.chain, value: nodeId }, adapter, opts.txLimitPerNode);
      if (nodeEdges === null) {
        frontier.set(nodeId, "unavailable");
        continue;
      }
      expandedIds.push(nodeId);

      const keepNeighbors = new Set(rankNeighbors(nodeEdges, nodeId).slice(0, opts.breadth));
      for (const edge of nodeEdges) {
        const key = edgeKey(edge);
        if (!edgeSeen.has(key)) {
          edgeSeen.add(key);
          edges.push(edge);
        }
        const neighbor = neighborOf(edge, nodeId);
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        if (keepNeighbors.has(neighbor)) nextLevel.push(neighbor);
        else frontier.set(neighbor, "breadth-cap");
      }
    }
    currentLevel = nextLevel;
  }
  // Anything left in currentLevel when the loop ends because maxHops was reached (not because the
  // graph genuinely ran out) is depth-capped, not expanded.
  for (const nodeId of currentLevel) if (!frontier.has(nodeId)) frontier.set(nodeId, "depth-cap");

  return {
    centerId,
    edges,
    expandedIds,
    frontier: [...frontier.entries()].map(([id, reason]) => ({ id, reason })),
    adapterCallsUsed: adapterCalls,
    budgetExhausted,
  };
}

export interface TracePathResult {
  found: boolean;
  /** Empty when `found` is false. Every edge in it individually satisfies every filter. */
  path: GraphEdge[];
  hopsSearched: number;
  nodesExplored: number;
  adapterCallsUsed: number;
  /** True when the search stopped because a cap was hit, not because "no path" was actually proven. */
  budgetExhausted: boolean;
}

/**
 * Searches outward from `from` for any path to `to` where every hop individually satisfies
 * `filters` — tracing one continuous qualifying flow, not finding an unrelated qualifying edge a
 * few hops off the real path. See `filters.ts` and ADR 0008 for why filters apply per-hop.
 */
export async function tracePath(
  from: Address,
  to: Address,
  adapter: ChainAdapter,
  filters: TraceFilters,
  opts: TraceOptions,
): Promise<TracePathResult> {
  const fromId = canonicalAddress(from.chain, from.value);
  const toId = canonicalAddress(to.chain, to.value);
  if (fromId === toId) return { found: false, path: [], hopsSearched: 0, nodesExplored: 0, adapterCallsUsed: 0, budgetExhausted: false };

  const visited = new Set<string>([fromId]);
  const cameFrom = new Map<string, GraphEdge>();
  let adapterCalls = 0;
  let nodesExplored = 0;
  let budgetExhausted = false;
  let hopsSearched = 0;
  let currentLevel = [fromId];

  function reconstructPath(targetId: string): GraphEdge[] {
    const path: GraphEdge[] = [];
    let cur = targetId;
    while (cur !== fromId) {
      const edge = cameFrom.get(cur);
      if (!edge) break;
      path.unshift(edge);
      cur = neighborOf(edge, cur);
    }
    return path;
  }

  for (let hop = 0; hop < opts.maxHops && currentLevel.length > 0; hop++) {
    hopsSearched = hop + 1;
    const nextLevel: string[] = [];
    for (const nodeId of currentLevel) {
      if (adapterCalls >= opts.maxAdapterCalls) {
        budgetExhausted = true;
        break;
      }
      adapterCalls++;
      const nodeEdges = await expandNode({ chain: from.chain, value: nodeId }, adapter, opts.txLimitPerNode);
      if (nodeEdges === null) continue; // couldn't check this node -- not a dead end, just unknown
      nodesExplored++;

      const matching = nodeEdges.filter((e) => edgeMatchesFilters(e, filters));
      for (const neighbor of rankNeighbors(matching, nodeId).slice(0, opts.breadth)) {
        if (visited.has(neighbor)) continue;
        const edge = matching.find((e) => neighborOf(e, nodeId) === neighbor);
        if (!edge) continue;
        visited.add(neighbor);
        cameFrom.set(neighbor, edge);
        if (neighbor === toId) {
          return { found: true, path: reconstructPath(toId), hopsSearched, nodesExplored, adapterCallsUsed: adapterCalls, budgetExhausted };
        }
        nextLevel.push(neighbor);
      }
    }
    if (adapterCalls >= opts.maxAdapterCalls) budgetExhausted = true;
    currentLevel = nextLevel;
  }
  // Stopped due to the depth cap with more graph left to explore -- that's "we didn't finish
  // looking," never collapsed into the same "not found" a real exhaustive search would report.
  if (currentLevel.length > 0) budgetExhausted = true;

  return { found: false, path: [], hopsSearched, nodesExplored, adapterCallsUsed: adapterCalls, budgetExhausted };
}

export type TracedNodeRole = "center" | "expanded" | "frontier";

/** A node in a traced graph/path, with its label/tags/entity from the label store — same fields Visualizer's GraphNode carries. */
export interface TracedNode {
  id: string;
  address: Address;
  role: TracedNodeRole;
  frontierReason?: FrontierReason;
  label: Label | null;
  tags: Tag[];
  entity: Entity | null;
}

async function labelNode(chain: Address["chain"], id: string, store: LabelStore): Promise<{ label: Label | null; tags: Tag[]; entity: Entity | null }> {
  const address: Address = { chain, value: id };
  const [label, tags, entity] = await Promise.all([store.getLabel(address), store.getTags(address), store.getEntity(address)]);
  return { label, tags, entity };
}

export interface TraceGraphReport extends TraceGraphResult {
  center: Address;
  nodes: TracedNode[];
}

/** `traceGraph` plus real label/tag/entity lookups for every node reached, same as Visualizer's `buildGraph`. */
export async function buildTraceGraph(center: Address, adapter: ChainAdapter, store: LabelStore, opts: TraceOptions): Promise<TraceGraphReport> {
  const result = await traceGraph(center, adapter, opts);
  const frontierReasons = new Map(result.frontier.map((f) => [f.id, f.reason]));
  const ids = [result.centerId, ...result.expandedIds.filter((id) => id !== result.centerId), ...result.frontier.map((f) => f.id)];
  const nodes = await Promise.all(
    ids.map(async (id): Promise<TracedNode> => {
      const { label, tags, entity } = await labelNode(center.chain, id, store);
      const reason = frontierReasons.get(id);
      const role: TracedNodeRole = id === result.centerId ? "center" : reason !== undefined ? "frontier" : "expanded";
      return { id, address: { chain: center.chain, value: id }, role, ...(reason !== undefined ? { frontierReason: reason } : {}), label, tags, entity };
    }),
  );
  return { ...result, center: { chain: center.chain, value: result.centerId }, nodes };
}

export interface TracePathReport extends TracePathResult {
  from: Address;
  to: Address;
  filters: TraceFilters;
  /** Every address on the found path, labeled — empty when `found` is false. */
  nodes: TracedNode[];
}

/** `tracePath` plus real label/tag/entity lookups for every address on the found path. */
export async function buildTracePath(
  from: Address,
  to: Address,
  adapter: ChainAdapter,
  store: LabelStore,
  filters: TraceFilters,
  opts: TraceOptions,
): Promise<TracePathReport> {
  const result = await tracePath(from, to, adapter, filters, opts);
  const ids = result.found
    ? [canonicalAddress(from.chain, from.value), ...result.path.map((edge) => edge.target), ...result.path.map((edge) => edge.source)].filter(
        (id, i, all) => all.indexOf(id) === i,
      )
    : [];
  const nodes = await Promise.all(
    ids.map(async (id): Promise<TracedNode> => {
      const { label, tags, entity } = await labelNode(from.chain, id, store);
      return { id, address: { chain: from.chain, value: id }, role: "expanded", label, tags, entity };
    }),
  );
  return { ...result, from, to, filters, nodes };
}
