import type { Address, ChainAdapter, ChainId, Entity, Label, LabelStore, Tag } from "@osstrace/core";
import { canonicalAddress } from "@osstrace/core";
import { deriveGraph, type GraphEdge } from "@osstrace/visualizer/src/graph.ts";
import type { BridgeDeadEnd, BridgeResolver } from "./bridges/wormhole.ts";
import { bridgeEdgeFromTransfer, type TraceEdge } from "./edges.ts";
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

/**
 * Opt-in cross-chain bridge following (ADR 0012). Without it, a trace stays on the start chain
 * with exactly ADR 0008's behaviour and call counts.
 */
export interface BridgeTracing {
  resolver: BridgeResolver;
  /** One adapter per chain. A node reached over a bridge is expanded with its own chain's adapter. */
  adapters: ReadonlyMap<ChainId, ChainAdapter>;
}

/** A node whose bridge lookup failed. This means "couldn't check", never "no bridge activity". */
export interface BridgeLookupFailure {
  id: string;
  chain: ChainId;
  reason: string;
}

export interface BridgeReport {
  enabled: boolean;
  protocol: "wormhole" | null;
  /** At most one per expanded node, so this is always `<= adapterCallsUsed`. */
  lookupsUsed: number;
  lookupFailures: BridgeLookupFailure[];
  /** Real bridge operations involving a traced node that can't be followed as a hop, each with the reason. */
  deadEnds: BridgeDeadEnd[];
  /** Operations Wormholescan returned without the fields needed to use them. Counted, never used. */
  malformedOperations: number;
}

class BridgeAccounting {
  readonly enabled: boolean;
  readonly protocol: "wormhole" | null;
  lookupsUsed = 0;
  readonly lookupFailures: BridgeLookupFailure[] = [];
  readonly deadEnds: BridgeDeadEnd[] = [];
  malformedOperations = 0;
  readonly #deadEndKeys = new Set<string>();

  constructor(bridging: BridgeTracing | undefined) {
    this.enabled = bridging !== undefined;
    this.protocol = bridging?.resolver.protocol ?? null;
  }

  addDeadEnd(deadEnd: BridgeDeadEnd): void {
    const key = `${deadEnd.operationId}|${deadEnd.nodeId}`;
    if (this.#deadEndKeys.has(key)) return;
    this.#deadEndKeys.add(key);
    this.deadEnds.push(deadEnd);
  }

  report(): BridgeReport {
    return {
      enabled: this.enabled,
      protocol: this.protocol,
      lookupsUsed: this.lookupsUsed,
      lookupFailures: this.lookupFailures,
      deadEnds: this.deadEnds,
      malformedOperations: this.malformedOperations,
    };
  }
}

type AdapterFor = (chain: ChainId) => ChainAdapter | null;

function adapterLookup(startChain: ChainId, adapter: ChainAdapter, bridging: BridgeTracing | undefined): AdapterFor {
  return (chain) => (chain === startChain ? adapter : bridging?.adapters.get(chain) ?? null);
}

/**
 * One real fetch + decode of a single node's edges, plus (when bridging is on) one bridge lookup
 * for that node. `null` means "couldn't check" (never "no edges"). The bridge lookup only runs
 * once the node's own chain data came back. If the lookup fails, the node's chain edges are still
 * returned and the failure is recorded.
 */
async function expandNode(
  node: Address,
  adapter: ChainAdapter,
  txLimit: number,
  bridging: BridgeTracing | undefined,
  acct: BridgeAccounting,
): Promise<TraceEdge[] | null> {
  const result = await adapter.getRecentTransactions(node.value, txLimit);
  if (!result.available) return null;
  const edges: TraceEdge[] = deriveGraph(node, result.transactions).edges;
  if (bridging) {
    acct.lookupsUsed++;
    const lookup = await bridging.resolver.lookup(node, txLimit);
    if (!lookup.available) {
      acct.lookupFailures.push({ id: canonicalAddress(node.chain, node.value), chain: node.chain, reason: lookup.reason });
    } else {
      for (const transfer of lookup.transfers) edges.push(bridgeEdgeFromTransfer(transfer));
      for (const deadEnd of lookup.deadEnds) acct.addDeadEnd(deadEnd);
      acct.malformedOperations += lookup.malformed;
    }
  }
  return edges;
}

function edgeKey(edge: TraceEdge): string {
  if (edge.kind === "bridge") return `bridge|${edge.id}`;
  const [a, b] = [edge.source, edge.target].sort();
  return `${edge.hash}|${a}|${b}|${edge.kind}|${edge.token?.address ?? ""}`;
}

function neighborOf(edge: TraceEdge, nodeId: string): string {
  return edge.source === nodeId ? edge.target : edge.source;
}

/**
 * The chain the neighbour across `edge` is on. A native/token edge never leaves its node's chain.
 * A bridge edge lands on its other side's chain. Node ids can't collide across chains: Ethereum's
 * are `0x` + hex, and base58 has no `0` (ADR 0012).
 */
function neighborChain(edge: TraceEdge, nodeId: string, nodeChain: ChainId): ChainId {
  if (edge.kind !== "bridge") return nodeChain;
  return edge.source === nodeId ? edge.targetChain : edge.sourceChain;
}

/** When an edge happened, as a sortable number. Unknown (ADR 0016) or unparseable is `-Infinity`: least recent. */
function edgeTime(edge: TraceEdge): number {
  if (edge.timestamp === null) return -Infinity;
  const t = Date.parse(edge.timestamp);
  return Number.isNaN(t) ? -Infinity : t;
}

/**
 * Distinct neighbors of `nodeId` among `edges`, most-recently-active first. A neighbor reached
 * only through edges with no known timestamp can't be dated, so it ranks after every neighbor that
 * can (ADR 0016); ties, including all-unknown, keep first-seen order (`sort` is stable). The
 * comparator never sees `NaN`, so the ordering is always well defined.
 */
function rankNeighbors(edges: readonly TraceEdge[], nodeId: string): string[] {
  const latest = new Map<string, number>();
  for (const edge of edges) {
    const neighbor = neighborOf(edge, nodeId);
    const t = edgeTime(edge);
    const prev = latest.get(neighbor);
    if (prev === undefined || t > prev) latest.set(neighbor, t);
  }
  return [...latest.entries()]
    .sort((a, b) => (a[1] === b[1] ? 0 : b[1] > a[1] ? 1 : -1))
    .map(([id]) => id);
}

export type FrontierReason = "depth-cap" | "breadth-cap" | "budget-exhausted" | "unavailable";

/** A node this trace reached but did not expand further, and honestly why — never implied to mean "no more connections." */
export interface FrontierNode {
  id: string;
  reason: FrontierReason;
}

/**
 * `E` defaults to Visualizer's `GraphEdge`, which is exactly what a single-chain trace returns.
 * A trace with bridging on is `TraceGraphResult<TraceEdge>`, since it can also contain bridge
 * edges. So existing single-chain callers (e.g. Risk Scoring) keep their exact types.
 */
export interface TraceGraphResult<E extends TraceEdge = GraphEdge> {
  centerId: string;
  /** Visualizer's native/token edges, plus `kind: "bridge"` edges when bridging is on (ADR 0012). */
  edges: E[];
  /** Node ids whose own transactions were actually fetched. */
  expandedIds: string[];
  frontier: FrontierNode[];
  /** The chain of every node id in this result. Only ever more than one chain when bridging is on. */
  nodeChains: Record<string, ChainId>;
  adapterCallsUsed: number;
  /** True if `maxAdapterCalls` was hit before the configured `maxHops`/`breadth` was fully explored. */
  budgetExhausted: boolean;
  bridges: BridgeReport;
}

/**
 * Expands a graph outward from `center` up to `opts.maxHops`, keeping every real edge it finds
 * (never dropped just because a node wasn't expanded further) but only recursing into each node's
 * `opts.breadth` most-recently-active distinct counterparties — "most recent" because mixing a
 * native amount and a token amount into one ranking would mean inventing an exchange rate (see
 * `filters.ts`), and recency is a real, well-defined order that needs none.
 *
 * With `bridging`, a bridge edge's far end goes into the same ranking as any other neighbour, and
 * when expanded it uses its own chain's adapter (ADR 0012).
 */
export async function traceGraph(center: Address, adapter: ChainAdapter, opts: TraceOptions): Promise<TraceGraphResult>;
export async function traceGraph(center: Address, adapter: ChainAdapter, opts: TraceOptions, bridging: BridgeTracing | undefined): Promise<TraceGraphResult<TraceEdge>>;
export async function traceGraph(center: Address, adapter: ChainAdapter, opts: TraceOptions, bridging?: BridgeTracing): Promise<TraceGraphResult<TraceEdge>> {
  const adapterFor = adapterLookup(center.chain, adapter, bridging);
  const acct = new BridgeAccounting(bridging);
  const centerId = canonicalAddress(center.chain, center.value);
  const chainOf = new Map<string, ChainId>([[centerId, center.chain]]);
  const visited = new Set<string>([centerId]);
  const edgeSeen = new Set<string>();
  const edges: TraceEdge[] = [];
  const frontier = new Map<string, FrontierReason>();
  const expandedIds: string[] = [];
  let adapterCalls = 0;
  let budgetExhausted = false;

  let currentLevel = [centerId];
  for (let hop = 0; hop < opts.maxHops && currentLevel.length > 0; hop++) {
    const nextLevel: string[] = [];
    for (const nodeId of currentLevel) {
      const nodeChain = chainOf.get(nodeId) ?? center.chain;
      const nodeAdapter = adapterFor(nodeChain);
      if (nodeAdapter === null) {
        frontier.set(nodeId, "unavailable");
        continue;
      }
      if (adapterCalls >= opts.maxAdapterCalls) {
        frontier.set(nodeId, "budget-exhausted");
        budgetExhausted = true;
        continue;
      }
      adapterCalls++;
      const nodeEdges = await expandNode({ chain: nodeChain, value: nodeId }, nodeAdapter, opts.txLimitPerNode, bridging, acct);
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
        chainOf.set(neighbor, neighborChain(edge, nodeId, nodeChain));
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
    nodeChains: Object.fromEntries(chainOf),
    adapterCallsUsed: adapterCalls,
    budgetExhausted,
    bridges: acct.report(),
  };
}

/** `E` defaults to `GraphEdge`, same as `TraceGraphResult`. */
export interface TracePathResult<E extends TraceEdge = GraphEdge> {
  found: boolean;
  /** Empty when `found` is false. Every edge in it individually satisfies every filter. */
  path: E[];
  /** The chain of every node id this search reached. */
  nodeChains: Record<string, ChainId>;
  hopsSearched: number;
  nodesExplored: number;
  adapterCallsUsed: number;
  /** True when the search stopped because a cap was hit, not because "no path" was actually proven. */
  budgetExhausted: boolean;
  bridges: BridgeReport;
}

/**
 * Searches outward from `from` for any path to `to` where every hop individually satisfies
 * `filters` — tracing one continuous qualifying flow, not finding an unrelated qualifying edge a
 * few hops off the real path. See `filters.ts` and ADR 0008 for why filters apply per-hop.
 *
 * `from` and `to` can be on different chains only when `bridging` is given (ADR 0012). Without
 * it no path could ever cross, so that combination throws instead of returning a "not found"
 * that would look like a real negative.
 */
export async function tracePath(from: Address, to: Address, adapter: ChainAdapter, filters: TraceFilters, opts: TraceOptions): Promise<TracePathResult>;
export async function tracePath(
  from: Address,
  to: Address,
  adapter: ChainAdapter,
  filters: TraceFilters,
  opts: TraceOptions,
  bridging: BridgeTracing | undefined,
): Promise<TracePathResult<TraceEdge>>;
export async function tracePath(
  from: Address,
  to: Address,
  adapter: ChainAdapter,
  filters: TraceFilters,
  opts: TraceOptions,
  bridging?: BridgeTracing,
): Promise<TracePathResult<TraceEdge>> {
  if (from.chain !== to.chain && bridging === undefined) {
    throw new Error(`a path from ${from.chain} to ${to.chain} can only be found with bridge tracing enabled`);
  }
  const adapterFor = adapterLookup(from.chain, adapter, bridging);
  const acct = new BridgeAccounting(bridging);
  const fromId = canonicalAddress(from.chain, from.value);
  const toId = canonicalAddress(to.chain, to.value);
  const chainOf = new Map<string, ChainId>([[fromId, from.chain]]);
  if (fromId === toId && from.chain === to.chain) {
    return { found: false, path: [], nodeChains: Object.fromEntries(chainOf), hopsSearched: 0, nodesExplored: 0, adapterCallsUsed: 0, budgetExhausted: false, bridges: acct.report() };
  }

  const visited = new Set<string>([fromId]);
  const cameFrom = new Map<string, TraceEdge>();
  let adapterCalls = 0;
  let nodesExplored = 0;
  let budgetExhausted = false;
  let hopsSearched = 0;
  let currentLevel = [fromId];

  function reconstructPath(targetId: string): TraceEdge[] {
    const path: TraceEdge[] = [];
    let cur = targetId;
    while (cur !== fromId) {
      const edge = cameFrom.get(cur);
      if (!edge) break;
      path.unshift(edge);
      cur = neighborOf(edge, cur);
    }
    return path;
  }

  const result = (found: boolean): TracePathResult<TraceEdge> => ({
    found,
    path: found ? reconstructPath(toId) : [],
    nodeChains: Object.fromEntries(chainOf),
    hopsSearched,
    nodesExplored,
    adapterCallsUsed: adapterCalls,
    budgetExhausted,
    bridges: acct.report(),
  });

  for (let hop = 0; hop < opts.maxHops && currentLevel.length > 0; hop++) {
    hopsSearched = hop + 1;
    const nextLevel: string[] = [];
    for (const nodeId of currentLevel) {
      const nodeChain = chainOf.get(nodeId) ?? from.chain;
      const nodeAdapter = adapterFor(nodeChain);
      if (nodeAdapter === null) continue; // no adapter for this chain -- unknown, not a dead end
      if (adapterCalls >= opts.maxAdapterCalls) {
        budgetExhausted = true;
        break;
      }
      adapterCalls++;
      const nodeEdges = await expandNode({ chain: nodeChain, value: nodeId }, nodeAdapter, opts.txLimitPerNode, bridging, acct);
      if (nodeEdges === null) continue; // couldn't check this node -- not a dead end, just unknown
      nodesExplored++;

      const matching = nodeEdges.filter((e) => edgeMatchesFilters(e, filters));
      // `breadth` limits which neighbours get *expanded*. It must not hide an edge already fetched
      // that reaches the target directly, so that check runs over every matching edge first.
      // Sparse bridge hops are rarely among a busy node's most recent `breadth` neighbours.
      const direct = matching.find((e) => neighborOf(e, nodeId) === toId && neighborChain(e, nodeId, nodeChain) === to.chain);
      if (direct && !visited.has(toId)) {
        visited.add(toId);
        chainOf.set(toId, to.chain);
        cameFrom.set(toId, direct);
        return result(true);
      }
      for (const neighbor of rankNeighbors(matching, nodeId).slice(0, opts.breadth)) {
        if (visited.has(neighbor)) continue;
        const edge = matching.find((e) => neighborOf(e, nodeId) === neighbor);
        if (!edge) continue;
        visited.add(neighbor);
        chainOf.set(neighbor, neighborChain(edge, nodeId, nodeChain));
        cameFrom.set(neighbor, edge);
        if (neighbor === toId) return result(true);
        nextLevel.push(neighbor);
      }
    }
    if (adapterCalls >= opts.maxAdapterCalls) budgetExhausted = true;
    currentLevel = nextLevel;
  }
  // Stopped due to the depth cap with more graph left to explore -- that's "we didn't finish
  // looking," never collapsed into the same "not found" a real exhaustive search would report.
  if (currentLevel.length > 0) budgetExhausted = true;

  return result(false);
}

export type TracedNodeRole = "center" | "expanded" | "frontier";

/** A node in a traced graph/path, with its label/tags/entity from the label store — same fields Visualizer's GraphNode carries. */
export interface TracedNode {
  id: string;
  /** The node's own chain, which differs from the start node's after a bridge hop. */
  address: Address;
  role: TracedNodeRole;
  frontierReason?: FrontierReason;
  label: Label | null;
  tags: Tag[];
  entity: Entity | null;
}

async function labelNode(address: Address, store: LabelStore): Promise<{ label: Label | null; tags: Tag[]; entity: Entity | null }> {
  const [label, tags, entity] = await Promise.all([store.getLabel(address), store.getTags(address), store.getEntity(address)]);
  return { label, tags, entity };
}

export interface TraceGraphReport extends TraceGraphResult<TraceEdge> {
  center: Address;
  nodes: TracedNode[];
}

/** `traceGraph` plus real label/tag/entity lookups for every node reached, same as Visualizer's `buildGraph`. */
export async function buildTraceGraph(
  center: Address,
  adapter: ChainAdapter,
  store: LabelStore,
  opts: TraceOptions,
  bridging?: BridgeTracing,
): Promise<TraceGraphReport> {
  const result = await traceGraph(center, adapter, opts, bridging);
  const frontierReasons = new Map(result.frontier.map((f) => [f.id, f.reason]));
  const ids = [result.centerId, ...result.expandedIds.filter((id) => id !== result.centerId), ...result.frontier.map((f) => f.id)];
  const nodes = await Promise.all(
    ids.map(async (id): Promise<TracedNode> => {
      const address: Address = { chain: result.nodeChains[id] ?? center.chain, value: id };
      const { label, tags, entity } = await labelNode(address, store);
      const reason = frontierReasons.get(id);
      const role: TracedNodeRole = id === result.centerId ? "center" : reason !== undefined ? "frontier" : "expanded";
      return { id, address, role, ...(reason !== undefined ? { frontierReason: reason } : {}), label, tags, entity };
    }),
  );
  return { ...result, center: { chain: center.chain, value: result.centerId }, nodes };
}

export interface TracePathReport extends TracePathResult<TraceEdge> {
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
  bridging?: BridgeTracing,
): Promise<TracePathReport> {
  const result = await tracePath(from, to, adapter, filters, opts, bridging);
  const ids = result.found
    ? [canonicalAddress(from.chain, from.value), ...result.path.map((edge) => edge.target), ...result.path.map((edge) => edge.source)].filter(
        (id, i, all) => all.indexOf(id) === i,
      )
    : [];
  const nodes = await Promise.all(
    ids.map(async (id): Promise<TracedNode> => {
      const address: Address = { chain: result.nodeChains[id] ?? from.chain, value: id };
      const { label, tags, entity } = await labelNode(address, store);
      return { id, address, role: "expanded", label, tags, entity };
    }),
  );
  return { ...result, from, to, filters, nodes };
}
