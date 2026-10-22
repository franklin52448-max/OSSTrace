import type { ChainId } from "@osstrace/core";
import type { GraphEdge } from "@osstrace/visualizer/src/graph.ts";
import type { BridgeTransfer } from "./bridges/wormhole.ts";

/**
 * A hop that crosses chains through a bridge. Its two ends are on different chains, and each end
 * has its own real transaction. See ADR 0012.
 *
 * It shares the fields consumers already rely on (`id`, `hash`, `source`, `target`,
 * `direction`, `kind`, `valueNative`, `timestamp`) with Visualizer's `GraphEdge`, so code that
 * walks edges keeps working. `hash` is the *source*-chain tx hash. The destination-chain one is
 * `bridge.targetTxHash`.
 */
export interface BridgeEdge {
  /** `wormhole:<operationId>`, unique per signed message. */
  id: string;
  hash: string;
  source: string;
  target: string;
  sourceChain: ChainId;
  targetChain: ChainId;
  /** Relative to the node whose expansion found it, same convention as `GraphEdge.direction`. */
  direction: "in" | "out";
  kind: "bridge";
  /** Always "0": what moved is in `token`. A bridge hop is never counted as a native transfer. */
  valueNative: "0";
  /** As Wormholescan resolved it. `symbol`/`amount` are `null` when it didn't, and are never guessed. */
  token: { address: string | null; symbol: string | null; amount: string | null };
  /** Source-chain timestamp (when the funds left). */
  timestamp: string;
  bridge: {
    protocol: "wormhole";
    operationId: string;
    appIds: string[];
    sourceTxHash: string;
    targetTxHash: string;
    /** When the destination-chain tx happened, if Wormholescan reported it. */
    targetTimestamp: string | null;
    /** Where the cross-chain link comes from. Tracer doesn't re-check it on either chain (ADR 0012). */
    evidence: "wormholescan";
    evidenceUrl: string;
  };
}

/** Every edge Tracer can return: Visualizer's single-chain native/token edges, plus bridge hops. */
export type TraceEdge = GraphEdge | BridgeEdge;

export function bridgeEdgeFromTransfer(transfer: BridgeTransfer): BridgeEdge {
  return {
    id: `${transfer.protocol}:${transfer.operationId}`,
    hash: transfer.source.txHash,
    source: transfer.source.address,
    target: transfer.target.address,
    sourceChain: transfer.source.chain,
    targetChain: transfer.target.chain,
    direction: transfer.direction,
    kind: "bridge",
    valueNative: "0",
    token: { address: transfer.token.address, symbol: transfer.token.symbol, amount: transfer.token.amount },
    timestamp: transfer.source.timestamp,
    bridge: {
      protocol: transfer.protocol,
      operationId: transfer.operationId,
      appIds: transfer.appIds,
      sourceTxHash: transfer.source.txHash,
      targetTxHash: transfer.target.txHash,
      targetTimestamp: transfer.target.timestamp,
      evidence: "wormholescan",
      evidenceUrl: transfer.evidenceUrl,
    },
  };
}
