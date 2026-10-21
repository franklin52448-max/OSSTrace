import type { Address, ChainAdapter, Entity, Label, LabelStore, Tag, TransactionSummary } from "@opentrace/core";
import { canonicalAddress, isRealAddress } from "./addressFormat.ts";
import { addDecimal, isDecimalString } from "./decimal.ts";

/** Per-node totals, computed only from the edges actually in this graph. */
export interface NodeStats {
  /** Number of edges touching this node. */
  txCount: number;
  /** Edges flowing INTO this node. */
  inCount: number;
  /** Edges flowing OUT OF this node. */
  outCount: number;
  /** Sum of native-token value flowing into this node, as an exact decimal string. */
  totalIn: string;
  /** Sum of native-token value flowing out of this node, as an exact decimal string. */
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
  /** Unique within this graph: the tx hash (suffixed with `#n` only if a hash repeats). */
  id: string;
  hash: string;
  source: string;
  target: string;
  /** Relative to the center node: "in" = counterparty -> center, "out" = center -> counterparty. */
  direction: "in" | "out";
  /** Native-token amount, decimal string, exactly as the chain adapter reported it. */
  valueNative: string;
  timestamp: string;
}

export type OmissionReason = "self-transfer" | "no-counterparty" | "counterparty-unresolved";

/**
 * A real transaction that was fetched but can't be drawn as an edge between two distinct real
 * addresses. Reported instead of silently dropped, and never turned into an invented node.
 */
export interface OmittedTransaction {
  hash: string;
  timestamp: string;
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

/**
 * Turns one address's recent transactions into a one-hop graph:
 * - "out" tx -> edge center -> `to`; "in" tx -> edge `from` -> center.
 * - "self" txs, txs with no counterparty (`to: null`, e.g. an Ethereum contract creation), and txs
 *   whose counterparty the adapter couldn't resolve (e.g. the Solana adapter's
 *   "unresolved (non-transfer instruction)" fallback) are listed in `omitted`, never drawn.
 */
export function deriveGraph(center: Address, transactions: readonly TransactionSummary[]): DerivedGraph {
  const chain = center.chain;
  const centerId = canonicalAddress(chain, center.value);
  const edges: GraphEdge[] = [];
  const omitted: OmittedTransaction[] = [];
  const stats = new Map<string, NodeStats>([[centerId, emptyStats()]]);
  const seenHashes = new Map<string, number>();

  for (const tx of transactions) {
    if (tx.direction === "self") {
      // A genuine self-transfer has the center on both ends. The Solana adapter also uses
      // "self" for "zero net balance change, counterparty unknown" and "RPC returned no tx" —
      // those are unresolved, not self-transfers, so they're reported as such.
      const isSelf = tx.to !== null && canonicalAddress(chain, tx.from) === centerId && canonicalAddress(chain, tx.to) === centerId;
      omitted.push(omit(tx, isSelf ? "self-transfer" : "counterparty-unresolved"));
      continue;
    }
    const rawCounterparty = tx.direction === "out" ? tx.to : tx.from;
    if (rawCounterparty === null) {
      omitted.push(omit(tx, "no-counterparty"));
      continue;
    }
    if (!isRealAddress(chain, rawCounterparty) || !isDecimalString(tx.valueNative)) {
      omitted.push(omit(tx, "counterparty-unresolved"));
      continue;
    }
    const counterpartyId = canonicalAddress(chain, rawCounterparty);
    if (counterpartyId === centerId) {
      omitted.push(omit(tx, "self-transfer"));
      continue;
    }

    const repeat = seenHashes.get(tx.hash) ?? 0;
    seenHashes.set(tx.hash, repeat + 1);
    const [source, target] = tx.direction === "out" ? [centerId, counterpartyId] : [counterpartyId, centerId];
    edges.push({
      id: repeat === 0 ? tx.hash : `${tx.hash}#${repeat}`,
      hash: tx.hash,
      source,
      target,
      direction: tx.direction,
      valueNative: tx.valueNative,
      timestamp: tx.timestamp,
    });

    const sourceStats = stats.get(source) ?? emptyStats();
    sourceStats.txCount += 1;
    sourceStats.outCount += 1;
    sourceStats.totalOut = addDecimal(sourceStats.totalOut, tx.valueNative);
    stats.set(source, sourceStats);

    const targetStats = stats.get(target) ?? emptyStats();
    targetStats.txCount += 1;
    targetStats.inCount += 1;
    targetStats.totalIn = addDecimal(targetStats.totalIn, tx.valueNative);
    stats.set(target, targetStats);
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
