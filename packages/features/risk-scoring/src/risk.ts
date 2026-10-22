import type { Address, Balance, ChainAdapter, ChainId, Label, LabelReader, Tag, TransactionsResult } from "@osstrace/core";
import { canonicalAddress } from "@osstrace/core";
import type { GraphEdge } from "@osstrace/visualizer/src/graph.ts";
import { clampTraceOptions, traceGraph, type FrontierReason, type TraceGraphResult, type TraceOptions } from "@osstrace/tracer/src/trace.ts";

/**
 * Risk scoring (ADR 0010). Two real signals, nothing else:
 *
 * 1. **Direct exposure** — the address itself carries a risk tag in the label dataset.
 * 2. **Hop-distance exposure** — Tracer's own `traceGraph` reaches an address carrying a risk tag
 *    within `maxHops` real transfers. The nearest one decides the score.
 *
 * The scoring rule is a lookup, not a model: see `SCORE_BY_HOPS` and ADR 0010 for the exact table.
 * The search half is Tracer's, reused as-is — this file never fetches a transaction itself except
 * through `traceGraph`, it only reads what `traceGraph` returned and asks the label store about it.
 */

/**
 * The tags that count as a risk signal, and why. Only a tag listed here moves a score — any other
 * tag in the dataset (e.g. Safe's `"protocol-contract"`) is ignored, never treated as risk by
 * default. Today the only risk tag any real ingested source produces is `"sanctioned"` (OFAC SDN +
 * UK Sanctions List). Adding a new one (e.g. a future `"exploit"` tag from a sourced post-incident
 * report) is a one-line change here plus a line in ADR 0010's table — never a tag no real source
 * actually emits.
 */
export const RISK_TAGS: Readonly<Record<string, string>> = {
  sanctioned: "Listed on a government sanctions list this project ingests (US OFAC SDN, UK Sanctions List)",
};

/** Score by hop distance to the nearest risk-tagged address. Index = hops (0 = the address itself). */
export const SCORE_BY_HOPS: readonly number[] = [100, 75, 50, 25];

/**
 * `severe` / `high` / `medium` / `low` map one-to-one to 0 / 1 / 2 / 3 hops. `none` is a real,
 * complete negative within the searched radius. `inconclusive` means no risk-tagged address was
 * found but the search did NOT cover everything within that radius — never reported as `none`.
 */
export type RiskTier = "severe" | "high" | "medium" | "low" | "none" | "inconclusive";

const TIER_BY_HOPS: readonly RiskTier[] = ["severe", "high", "medium", "low"];

/** The search options risk scoring uses unless the caller overrides them (then clamped by Tracer's own `clampTraceOptions`). */
export const DEFAULT_RISK_TRACE_OPTIONS: TraceOptions = { maxHops: 2, breadth: 5, txLimitPerNode: 25, maxAdapterCalls: 40 };

export function clampRiskOptions(opts: Partial<TraceOptions>): TraceOptions {
  return clampTraceOptions({ ...DEFAULT_RISK_TRACE_OPTIONS, ...opts });
}

export function riskTagsOf(tags: readonly Tag[]): Tag[] {
  return tags.filter((t) => Object.hasOwn(RISK_TAGS, t.tag));
}

/**
 * Why part of the radius wasn't covered. The first three are Tracer's own `FrontierReason`s;
 * `history-truncated` is risk scoring's addition: an address whose transaction page came back full
 * (as many transactions as were asked for), so older transactions — and the counterparties in
 * them — were never seen. Tracer's `depth-cap` is deliberately NOT a gap: a depth-capped node sits
 * exactly at `maxHops`, its own tags were checked, and what lies past it is outside the radius
 * this score claims anything about (reported separately as `beyondRadius`).
 */
export type SearchGapReason = Exclude<FrontierReason, "depth-cap"> | "history-truncated";

export interface SearchGap {
  id: string;
  /** Hop distance of the node that wasn't (fully) expanded. Its own tags WERE checked; its neighbors weren't. */
  hops: number;
  reason: SearchGapReason;
  /** For `unavailable`: the chain adapter's own reason text (e.g. an RPC rate-limit), when it gave one. */
  detail?: string;
}

export interface FlaggedAddress {
  id: string;
  hops: number;
  /** Only the risk tags (see `RISK_TAGS`), each with its real source. */
  riskTags: Tag[];
}

export interface NearestExposure extends FlaggedAddress {
  label: Label | null;
  /** The real edges from the scored address to the flagged one, in order — the evidence. */
  path: GraphEdge[];
}

export interface RiskSearchSummary {
  maxHops: number;
  breadth: number;
  txLimitPerNode: number;
  maxAdapterCalls: number;
  adapterCallsUsed: number;
  /** Every distinct address reached (center included) — each one's tags were checked. */
  nodesChecked: number;
  edgesFollowed: number;
  /** True when every address within `maxHops` reachable through the fetched history was checked. */
  complete: boolean;
  gaps: SearchGap[];
  /** Nodes Tracer reached at exactly `maxHops` and stopped at by design (its `depth-cap`). Not a gap — the radius edge. */
  beyondRadius: number;
}

export interface RiskAssessment {
  address: Address;
  /** 0-100 per ADR 0010, or `null` when the tier is `inconclusive` (no number can honestly be given). */
  score: number | null;
  tier: RiskTier;
  basis: "direct" | "hop-distance" | "none";
  /** Risk tags on the address itself. Non-empty exactly when `basis === "direct"`. */
  directTags: Tag[];
  nearest: NearestExposure | null;
  /** Every risk-tagged address found within the radius, nearest first. */
  flagged: FlaggedAddress[];
  /** `null` when no hop search ran (a direct tag already gives the maximum score). */
  search: RiskSearchSummary | null;
  /** Top-level mirror of `!search.complete`, so no caller can miss it. `false` when no search was needed. */
  searchIncomplete: boolean;
  /**
   * True when a gap sits close enough to the scored address that a NEARER risk-tagged address could
   * exist in it — so the real score could be higher than `score`. Always true for `inconclusive`.
   */
  scoreIsLowerBound: boolean;
  explanation: string;
}

/** Hop distance from `centerId` to every node in `edges` (undirected), plus one shortest-path parent edge per node. */
function shortestPaths(centerId: string, edges: readonly GraphEdge[]): { hops: Map<string, number>; parent: Map<string, GraphEdge> } {
  const adjacency = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    for (const end of [edge.source, edge.target]) {
      const list = adjacency.get(end) ?? [];
      list.push(edge);
      adjacency.set(end, list);
    }
  }
  const hops = new Map<string, number>([[centerId, 0]]);
  const parent = new Map<string, GraphEdge>();
  let level = [centerId];
  for (let d = 1; level.length > 0; d++) {
    const next: string[] = [];
    for (const node of level) {
      for (const edge of adjacency.get(node) ?? []) {
        const other = edge.source === node ? edge.target : edge.source;
        if (hops.has(other)) continue;
        hops.set(other, d);
        parent.set(other, edge);
        next.push(other);
      }
    }
    level = next;
  }
  return { hops, parent };
}

function pathTo(centerId: string, targetId: string, parent: ReadonlyMap<string, GraphEdge>): GraphEdge[] {
  const path: GraphEdge[] = [];
  let cur = targetId;
  while (cur !== centerId) {
    const edge = parent.get(cur);
    if (!edge) break;
    path.unshift(edge);
    cur = edge.source === cur ? edge.target : edge.source;
  }
  return path;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Everything `scoreRisk` needs, already fetched. No I/O happens inside `scoreRisk`. */
export interface RiskInputs {
  center: Address;
  /** Every tag on the center itself (risk tags are filtered out of these here). */
  centerTags: readonly Tag[];
  /** `null` only when a direct risk tag made the hop search unnecessary. */
  trace: TraceGraphResult | null;
  opts: TraceOptions;
  /** Tags of every node in `trace` (keyed by node id). A node missing here is treated as untagged. */
  tagsById: ReadonlyMap<string, readonly Tag[]>;
  labelsById: ReadonlyMap<string, Label | null>;
  /** How many transactions the adapter actually returned for each expanded node. */
  fetchedCountById: ReadonlyMap<string, number>;
  /** The adapter's reason text per unavailable node, shown on the matching gap. Optional. */
  unavailableReasonById?: ReadonlyMap<string, string>;
}

/** The scoring rule itself (ADR 0010), as a pure function of real, already-fetched data. */
export function scoreRisk(inputs: RiskInputs): RiskAssessment {
  const centerId = canonicalAddress(inputs.center.chain, inputs.center.value);
  const address: Address = { chain: inputs.center.chain, value: centerId };
  const directTags = riskTagsOf(inputs.centerTags);

  if (directTags.length > 0) {
    const names = [...new Set(directTags.map((t) => t.tag))].join(", ");
    return {
      address,
      score: SCORE_BY_HOPS[0] as number,
      tier: "severe",
      basis: "direct",
      directTags,
      nearest: null,
      flagged: [{ id: centerId, hops: 0, riskTags: directTags }],
      search: null,
      searchIncomplete: false,
      scoreIsLowerBound: false,
      explanation: `This address itself carries the risk tag "${names}" (${plural(directTags.length, "cited source")}). That is the maximum score, so no hop search was needed.`,
    };
  }

  const trace = inputs.trace;
  if (trace === null) throw new Error("scoreRisk: a trace is required when the address has no direct risk tag");
  const { hops, parent } = shortestPaths(centerId, trace.edges);
  const maxHops = inputs.opts.maxHops;

  const gaps: SearchGap[] = [];
  let beyondRadius = 0;
  for (const f of trace.frontier) {
    if (f.reason === "depth-cap") {
      beyondRadius++;
      continue;
    }
    const d = f.id === centerId ? 0 : hops.get(f.id);
    // A node not reached within the radius can't hide anything inside it.
    if (d === undefined || d >= maxHops) continue;
    const detail = f.reason === "unavailable" ? inputs.unavailableReasonById?.get(f.id) : undefined;
    gaps.push({ id: f.id, hops: d, reason: f.reason, ...(detail !== undefined ? { detail } : {}) });
  }
  for (const id of trace.expandedIds) {
    const d = id === centerId ? 0 : hops.get(id);
    const fetched = inputs.fetchedCountById.get(id);
    if (d !== undefined && d < maxHops && fetched !== undefined && fetched >= inputs.opts.txLimitPerNode) {
      gaps.push({ id, hops: d, reason: "history-truncated" });
    }
  }
  gaps.sort((a, b) => a.hops - b.hops || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const flagged: FlaggedAddress[] = [];
  for (const [id, d] of hops) {
    if (id === centerId || d > maxHops) continue;
    const riskTags = riskTagsOf(inputs.tagsById.get(id) ?? []);
    if (riskTags.length > 0) flagged.push({ id, hops: d, riskTags });
  }
  flagged.sort((a, b) => a.hops - b.hops || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const search: RiskSearchSummary = {
    maxHops,
    breadth: inputs.opts.breadth,
    txLimitPerNode: inputs.opts.txLimitPerNode,
    maxAdapterCalls: inputs.opts.maxAdapterCalls,
    adapterCallsUsed: trace.adapterCallsUsed,
    nodesChecked: hops.size,
    edgesFollowed: trace.edges.length,
    complete: gaps.length === 0,
    gaps,
    beyondRadius,
  };
  const gapSummary = summarizeGaps(gaps);
  const nearestFlag = flagged[0];

  if (nearestFlag === undefined) {
    if (search.complete) {
      return {
        address,
        score: 0,
        tier: "none",
        basis: "none",
        directTags: [],
        nearest: null,
        flagged: [],
        search,
        searchIncomplete: false,
        scoreIsLowerBound: false,
        explanation:
          `No risk-tagged address within ${plural(maxHops, "hop")}: all ${plural(hops.size, "address")} reached were checked, and no part of the radius was skipped. ` +
          `This only covers risk sources this project has ingested, and only the history each address's adapter returned.`,
      };
    }
    return {
      address,
      score: null,
      tier: "inconclusive",
      basis: "none",
      directTags: [],
      nearest: null,
      flagged: [],
      search,
      searchIncomplete: true,
      scoreIsLowerBound: true,
      explanation:
        `No risk-tagged address found within ${plural(maxHops, "hop")}, but the search did not cover the whole radius (${gapSummary}). ` +
        `This is NOT a clean result — a risk-tagged address could be in the part that wasn't checked.`,
    };
  }

  const d = nearestFlag.hops;
  // A gap at distance g leaves addresses at g+1 unchecked; only a gap with g+1 < d could hide a nearer flagged address.
  const scoreIsLowerBound = gaps.some((g) => g.hops + 1 < d);
  const tagNames = [...new Set(nearestFlag.riskTags.map((t) => t.tag))].join(", ");
  return {
    address,
    score: SCORE_BY_HOPS[d] as number,
    tier: TIER_BY_HOPS[d] as RiskTier,
    basis: "hop-distance",
    directTags: [],
    nearest: { ...nearestFlag, label: inputs.labelsById.get(nearestFlag.id) ?? null, path: pathTo(centerId, nearestFlag.id, parent) },
    flagged,
    search,
    searchIncomplete: !search.complete,
    scoreIsLowerBound,
    explanation:
      `Nearest risk-tagged address ("${tagNames}") is ${plural(d, "hop")} away via real transfers.` +
      (flagged.length > 1 ? ` ${flagged.length} risk-tagged addresses found within ${plural(maxHops, "hop")} in total.` : "") +
      (scoreIsLowerBound
        ? ` The search did not cover everything closer than that (${gapSummary}), so a nearer one could exist — treat this score as a minimum.`
        : !search.complete
          ? ` Parts of the radius further out were not checked (${gapSummary}); they can't change this score, but more flagged addresses could exist there.`
          : ""),
  };
}

function summarizeGaps(gaps: readonly SearchGap[]): string {
  const counts = new Map<SearchGapReason, number>();
  for (const g of gaps) counts.set(g.reason, (counts.get(g.reason) ?? 0) + 1);
  const words: Record<SearchGapReason, string> = {
    "breadth-cap": "not expanded (breadth cap)",
    "budget-exhausted": "not expanded (call budget ran out)",
    unavailable: "couldn't be fetched (adapter unavailable)",
    "history-truncated": "had more history than was fetched",
  };
  return [...counts.entries()].map(([reason, n]) => `${plural(n, "address")} ${words[reason]}`).join("; ");
}

/**
 * A `ChainAdapter` pass-through that records how many transactions each address actually returned,
 * so `scoreRisk` can tell "this node's whole history was seen" from "its page came back full". It
 * changes nothing about what Tracer sees.
 */
export class RecordingAdapter implements ChainAdapter {
  readonly chain: ChainId;
  readonly #inner: ChainAdapter;
  readonly fetchedCountById = new Map<string, number>();
  /** The adapter's own reason text for every address it couldn't fetch (Tracer keeps only "unavailable"). */
  readonly unavailableReasonById = new Map<string, string>();

  constructor(inner: ChainAdapter) {
    this.chain = inner.chain;
    this.#inner = inner;
  }

  getBalance(address: string): Promise<Balance> {
    return this.#inner.getBalance(address);
  }

  async getRecentTransactions(address: string, limit: number): Promise<TransactionsResult> {
    const result = await this.#inner.getRecentTransactions(address, limit);
    const id = canonicalAddress(this.chain, address);
    if (result.available) this.fetchedCountById.set(id, result.transactions.length);
    else this.unavailableReasonById.set(id, result.reason);
    return result;
  }
}

/**
 * Orchestrates the label store + Tracer into a `RiskAssessment`. Cost: zero adapter calls when the
 * address itself is risk-tagged; otherwise exactly one `traceGraph` run (bounded by
 * `opts.maxAdapterCalls`), plus one local label-store lookup per node reached.
 */
export async function assessRisk(center: Address, adapter: ChainAdapter, store: LabelReader, opts: TraceOptions): Promise<RiskAssessment> {
  const centerId = canonicalAddress(center.chain, center.value);
  const centerAddress: Address = { chain: center.chain, value: centerId };
  const centerTags = await store.getTags(centerAddress);
  const base = { center: centerAddress, centerTags, opts, tagsById: new Map(), labelsById: new Map(), fetchedCountById: new Map() };
  if (riskTagsOf(centerTags).length > 0) return scoreRisk({ ...base, trace: null });

  const recording = new RecordingAdapter(adapter);
  const trace = await traceGraph(centerAddress, recording, opts);
  const ids = new Set<string>();
  for (const edge of trace.edges) {
    ids.add(edge.source);
    ids.add(edge.target);
  }
  ids.delete(centerId);
  const tagsById = new Map<string, Tag[]>();
  const labelsById = new Map<string, Label | null>();
  await Promise.all(
    [...ids].map(async (id) => {
      const address: Address = { chain: center.chain, value: id };
      const tags = await store.getTags(address);
      tagsById.set(id, tags);
      // Only a risk-tagged node's label is ever shown (as the nearest exposure), so only those are looked up.
      if (riskTagsOf(tags).length > 0) labelsById.set(id, await store.getLabel(address));
    }),
  );
  return scoreRisk({
    ...base,
    trace,
    tagsById,
    labelsById,
    fetchedCountById: recording.fetchedCountById,
    unavailableReasonById: recording.unavailableReasonById,
  });
}
