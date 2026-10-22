import type { Address, ChainAdapter, Entity, Label, LabelStore, Tag, TokenTransfer, TransactionSummary } from "@osstrace/core";
import { canonicalAddress, isRealAddress } from "./addressFormat.ts";
import { addDecimal, isDecimalString } from "./decimal.ts";

/** Per-node totals, computed only from the edges actually in this graph. */
export interface NodeStats {
  /** Number of edges touching this node (native + token). */
  txCount: number;
  /** Edges flowing INTO this node. */
  inCount: number;
  /** Edges flowing OUT OF this node. */
  outCount: number;
  /** Sum of native-token value flowing into this node, as an exact decimal string. Token-transfer
   *  edges don't contribute here — different units can't be summed into one number without
   *  inventing an exchange rate, so each token edge carries its own amount instead (see
   *  `GraphEdge.token`). */
  totalIn: string;
  /** Sum of native-token value flowing out of this node, as an exact decimal string. See `totalIn`. */
  totalOut: string;
}

export interface GraphNode {
  /** Stable id used by `GraphEdge.source`/`target` — the canonical address value. */
  id: string;
  address: Address;
  /** "center" is the queried address; every other node is one of its direct counterparties. */
  role: "center" | "counterparty";
  label: Label | null;
  tags: Tag[];
  entity: Entity | null;
  stats: NodeStats;
}

/** One real transfer between two nodes. Direction is the real on-chain direction: source -> target. */
export interface GraphEdge {
  /** Unique within this graph: the tx hash, suffixed with `#n` for the n-th extra edge sharing
   *  that hash (a repeat native transfer, or any token leg alongside/instead of a native one). */
  id: string;
  hash: string;
  source: string;
  target: string;
  /** Relative to the center node: "in" = counterparty -> center, "out" = center -> counterparty. */
  direction: "in" | "out";
  /** "native": the chain's own currency. "token": one decoded ERC-20/SPL transfer from the same tx. */
  kind: "native" | "token";
  /** Native-token amount, decimal string. "0" for a "token"-kind edge — its real amount is in `token`. */
  valueNative: string;
  /** Present only for `kind: "token"` edges. */
  token?: { address: string | null; symbol: string | null; amount: string | null; rawAmount: string };
  /** The transaction's own timestamp — `null` when the chain didn't report one (ADR 0016). */
  timestamp: string | null;
}

export type OmissionReason = "self-transfer" | "no-counterparty" | "counterparty-unresolved" | "failed";

/**
 * A real transaction that was fetched but can't be drawn as an edge between two distinct real
 * addresses. Reported instead of silently dropped, and never turned into an invented node.
 */
export interface OmittedTransaction {
  hash: string;
  /** `null` when the chain didn't report one (ADR 0016). */
  timestamp: string | null;
  direction: TransactionSummary["direction"];
  valueNative: string;
  reason: OmissionReason;
}

export interface GraphReport {
  center: Address;
  /** Always 1 in v1: only the center's direct counterparties. See README "What's not built yet". */
  hops: 1;
  /** Did the chain adapter actually return history? Mirrors core's TransactionsResult. */
  transactions: { available: true; fetched: number } | { available: false; reason: string };
  /** Always contains the center node first, even when history is unavailable. */
  nodes: GraphNode[];
  edges: GraphEdge[];
  omitted: OmittedTransaction[];
}

/** The pure, label-free part: real transactions in, graph structure out. No I/O. */
export interface DerivedGraph {
  centerId: string;
  /** Canonical counterparty ids, center excluded, ordered by edge count desc then id. */
  counterpartyIds: string[];
  edges: GraphEdge[];
  omitted: OmittedTransaction[];
  stats: Map<string, NodeStats>;
}

function emptyStats(): NodeStats {
  return { txCount: 0, inCount: 0, outCount: 0, totalIn: "0", totalOut: "0" };
}

function omit(tx: TransactionSummary, reason: OmissionReason): OmittedTransaction {
  return { hash: tx.hash, timestamp: tx.timestamp, direction: tx.direction, valueNative: tx.valueNative, reason };
}

function bumpStats(stats: Map<string, NodeStats>, source: string, target: string, nativeAmount: string | null): void {
  const sourceStats = stats.get(source) ?? emptyStats();
  sourceStats.txCount += 1;
  sourceStats.outCount += 1;
  if (nativeAmount !== null) sourceStats.totalOut = addDecimal(sourceStats.totalOut, nativeAmount);
  stats.set(source, sourceStats);

  const targetStats = stats.get(target) ?? emptyStats();
  targetStats.txCount += 1;
  targetStats.inCount += 1;
  if (nativeAmount !== null) targetStats.totalIn = addDecimal(targetStats.totalIn, nativeAmount);
  stats.set(target, targetStats);
}

/** Attempts the native-currency leg of one transaction. Returns the reason it can't be drawn, or null if it was drawn. */
function tryNativeEdge(
  chain: Address["chain"],
  centerId: string,
  tx: TransactionSummary,
  push: (edge: Omit<GraphEdge, "id">) => void,
): OmissionReason | null {
  if (tx.direction === "self") {
    // A genuine self-transfer has the center on both ends. The Solana adapter also uses "self"
    // for "zero net balance change, counterparty unknown" and "RPC returned no tx" — those are
    // unresolved, not self-transfers, so they're reported as such.
    const isSelf = tx.to !== null && canonicalAddress(chain, tx.from) === centerId && canonicalAddress(chain, tx.to) === centerId;
    return isSelf ? "self-transfer" : "counterparty-unresolved";
  }
  const rawCounterparty = tx.direction === "out" ? tx.to : tx.from;
  if (rawCounterparty === null) return "no-counterparty";
  if (!isRealAddress(chain, rawCounterparty) || !isDecimalString(tx.valueNative)) return "counterparty-unresolved";
  const counterpartyId = canonicalAddress(chain, rawCounterparty);
  if (counterpartyId === centerId) return "self-transfer";

  const [source, target] = tx.direction === "out" ? [centerId, counterpartyId] : [counterpartyId, centerId];
  push({ hash: tx.hash, source, target, direction: tx.direction, kind: "native", valueNative: tx.valueNative, timestamp: tx.timestamp });
  return null;
}

/** Draws every token-transfer leg of one transaction that resolves to a real, distinct counterparty. */
function drawTokenEdges(
  chain: Address["chain"],
  centerId: string,
  tx: TransactionSummary,
  push: (edge: Omit<GraphEdge, "id">) => void,
): number {
  let drawn = 0;
  for (const t of tx.tokenTransfers ?? []) {
    if (t.direction === "self") continue;
    const rawCounterparty: string | null = t.direction === "out" ? t.to : t.from;
    if (rawCounterparty === null || !isRealAddress(chain, rawCounterparty)) continue;
    const counterpartyId = canonicalAddress(chain, rawCounterparty);
    if (counterpartyId === centerId) continue;

    const [source, target]: [string, string] = t.direction === "out" ? [centerId, counterpartyId] : [counterpartyId, centerId];
    push({
      hash: tx.hash,
      source,
      target,
      direction: t.direction,
      kind: "token",
      valueNative: "0",
      token: { address: t.token, symbol: t.symbol, amount: t.amount, rawAmount: t.rawAmount },
      timestamp: tx.timestamp,
    });
    drawn++;
  }
  return drawn;
}

/**
 * Turns one address's recent transactions into a one-hop graph. Each transaction can draw zero,
 * one, or several edges:
 * - its native-currency leg (center -> counterparty for "out", counterparty -> center for "in"),
 *   when the chain adapter resolved a real counterparty for it; and
 * - one edge per decoded token transfer (`TokenTransfer`, e.g. an ERC-20/SPL transfer) in the same
 *   transaction that resolves to a real, distinct counterparty — independent of whether the native
 *   leg itself was resolvable, since a token-only transaction (e.g. a plain USDC transfer) has no
 *   resolvable native leg at all.
 * A transaction that produces neither is listed in `omitted` (the native leg's reason), never
 * silently dropped and never turned into an invented edge.
 *
 * A transaction the chain adapter reports as `status: "failed"` (reverted on-chain) is never
 * resolved at all — skipped straight to `omitted` with reason `"failed"`, before either attempt.
 * Whatever `tx.to`/`tx.tokenTransfers` describe is what it *attempted*; nothing actually moved,
 * so drawing an edge for it would show a transfer that never happened.
 */
export function deriveGraph(center: Address, transactions: readonly TransactionSummary[]): DerivedGraph {
  const chain = center.chain;
  const centerId = canonicalAddress(chain, center.value);
  const edges: GraphEdge[] = [];
  const omitted: OmittedTransaction[] = [];
  const stats = new Map<string, NodeStats>([[centerId, emptyStats()]]);
  const seenHashes = new Map<string, number>();

  for (const tx of transactions) {
    if (tx.status === "failed") {
      omitted.push(omit(tx, "failed"));
      continue;
    }

    const drawnThisTx: Omit<GraphEdge, "id">[] = [];
    const push = (edge: Omit<GraphEdge, "id">): void => void drawnThisTx.push(edge);

    const nativeOmissionReason = tryNativeEdge(chain, centerId, tx, push);
    drawTokenEdges(chain, centerId, tx, push);

    if (drawnThisTx.length === 0) {
      omitted.push(omit(tx, nativeOmissionReason ?? "counterparty-unresolved"));
      continue;
    }

    for (const edge of drawnThisTx) {
      const repeat = seenHashes.get(tx.hash) ?? 0;
      seenHashes.set(tx.hash, repeat + 1);
      edges.push({ id: repeat === 0 ? tx.hash : `${tx.hash}#${repeat}`, ...edge });
      bumpStats(stats, edge.source, edge.target, edge.kind === "native" ? edge.valueNative : null);
    }
  }

  const counterpartyIds = [...stats.keys()]
    .filter((id) => id !== centerId)
    .sort((a, b) => (stats.get(b)?.txCount ?? 0) - (stats.get(a)?.txCount ?? 0) || (a < b ? -1 : a > b ? 1 : 0));

  return { centerId, counterpartyIds, edges, omitted, stats };
}

/**
 * Orchestrates one chain adapter + the label store into a GraphReport. Cost per call: exactly one
 * `getRecentTransactions` call on the adapter (no per-counterparty chain calls — that's what keeps
 * this one-hop), plus one local label-store lookup per node.
 */
export async function buildGraph(center: Address, adapter: ChainAdapter, store: LabelStore, txLimit = 25): Promise<GraphReport> {
  const result = await adapter.getRecentTransactions(center.value, txLimit);
  const derived = deriveGraph(center, result.available ? result.transactions : []);

  const nodeIds = [derived.centerId, ...derived.counterpartyIds];
  const nodes = await Promise.all(
    nodeIds.map(async (id): Promise<GraphNode> => {
      const address: Address = { chain: center.chain, value: id };
      const [label, tags, entity] = await Promise.all([store.getLabel(address), store.getTags(address), store.getEntity(address)]);
      return {
        id,
        address,
        role: id === derived.centerId ? "center" : "counterparty",
        label,
        tags,
        entity,
        stats: derived.stats.get(id) ?? emptyStats(),
      };
    }),
  );

  return {
    center: { chain: center.chain, value: derived.centerId },
    hops: 1,
    transactions: result.available ? { available: true, fetched: result.transactions.length } : { available: false, reason: result.reason },
    nodes,
    edges: derived.edges,
    omitted: derived.omitted,
  };
}
