// Core domain types shared by the server and the web UI.

export type Chain = "solana" | "ethereum";
export const CHAINS: readonly Chain[] = ["solana", "ethereum"] as const;

export type XY = { x: number; y: number };

export type EntityRef = {
  id: string;
  name: string;
  type?: string | null;
  /** "user" = created by the signed-in user. Open datasets can be added later with their own source. */
  source: string;
};

export type LabelRef = { id: string; name: string; note?: string | null; source: string };

/** An address as shown in the UI, joined with the signed-in user's own labels/entities. */
export type AddressInfo = {
  address: string;
  chain: Chain;
  entity?: EntityRef | null;
  label?: LabelRef | null;
  tags?: TagRef[];
  /** Token-account owner (Solana). */
  ownerAddress?: AddressInfo | null;
  isProgram?: boolean;
};

export type TagRef = { id: string; name: string; color: string };

export type Transfer = {
  /** `<txid>_<ordinal>` (Solana) / `<txhash>_<logIndex|traceIndex>` (EVM). Unique per chain. */
  id: string;
  chain: Chain;
  txHash: string;
  blockNumber: number;
  /** ISO-8601 UTC */
  blockTimestamp: string;
  from: AddressInfo;
  to: AddressInfo;
  /** Token identity: mint (Solana), contract (EVM), or "native". */
  tokenId: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  tokenDecimals: number | null;
  /** Raw integer amount as decimal string (never a float). */
  amountRaw: string;
  /** amountRaw / 10^decimals as decimal string. */
  amount: string;
  /** USD value at transfer time, or null when no price source had one. Never invented. */
  usd: number | null;
  priceSource: string | null;
};

export type Counterparty = {
  address: AddressInfo;
  usd: number;
  transactionCount: number;
  flow: "in" | "out";
  chains: Chain[];
};

export type TokenBalance = {
  tokenId: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  amountRaw: string;
  amount: string;
  usd: number | null;
  price: number | null;
  priceSource: string | null;
};

export type BalancesResponse = {
  address: AddressInfo;
  balances: TokenBalance[];
  totalUsd: number | null;
  fetchedAt: string;
  /** true when the provider returned more tokens than were included (e.g. spam-token wallets). */
  truncated?: boolean;
  /** Number of token balances the provider reported, when known. */
  totalTokenCount?: number | null;
};

// ---------- Tracer ----------

export type NodeKind = "address" | "entity" | "transaction";
export type NodeColor = "blue" | "green" | "amber" | "red" | "purple" | "gray";

export type TraceNode = {
  id: string;
  kind: NodeKind;
  /** TOP-LEFT corner of the card in world coordinates. */
  currentPosition: XY;
  createdAt: string;
  width?: number | null;
  height?: number | null;
  color?: NodeColor | null;
  address?: string;
  chain?: Chain;
  displayAddress?: AddressInfo;
  entityID?: string;
  displayEntity?: EntityRef;
  transactionChain?: Chain;
  transactionHash?: string;
};

export type AggregateSummary = {
  cachedUSDIn: number;
  cachedTransactionCountIn: number;
  cachedUSDOut: number;
  cachedTransactionCountOut: number;
  /** ISO-8601 UTC */
  cachedAt: string;
};

export type TraceEdge =
  | { id: string; kind: "aggregate"; fromNodeID: string; toNodeID: string; createdAt: string; aggregate: AggregateSummary }
  | {
      id: string;
      kind: "transfer";
      fromNodeID: string;
      toNodeID: string;
      createdAt: string;
      chain: Chain;
      transferID: string;
      displayTransfer?: Transfer;
    };

export type Trace = {
  uuid: string;
  title: string;
  notes: string;
  nodes: TraceNode[];
  edges: TraceEdge[];
  shareable: boolean;
  isOwner: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TraceSummary = {
  uuid: string;
  title: string;
  notes: string;
  shareable: boolean;
  addressCount: number;
  entityCount: number;
  transferCount: number;
  createdAt: string;
  updatedAt: string;
};

/** Client timestamps are ISO-8601 strings; larger string = later (same format, UTC). */
export type TraceOp =
  | { type: "create_node"; node: TraceNode }
  | { type: "delete_node"; id: string }
  | { type: "create_edge"; edge: TraceEdge }
  | { type: "delete_edge"; id: string }
  | { type: "update_edge_endpoints"; id: string; fromNodeID?: string; toNodeID?: string }
  | { type: "update_node_position"; id: string; position: XY; clientTimestamp: string }
  | { type: "update_node_size"; id: string; width: number | null; height: number | null }
  | { type: "set_node_color"; id: string; color: NodeColor | null }
  | { type: "set_title"; title: string }
  | { type: "set_notes"; notes: string }
  | { type: "set_shareable"; shareable: boolean };

// ---------- Visualizer ----------

export type FlowFilter = "all" | "in" | "out" | "self";

export type VisualizerFilter = {
  flow: FlowFilter;
  from: string[] | null;
  to: string[] | null;
  tokens: string[] | null;
  chains: Chain[] | null;
  valueGte: number | null;
  valueLte: number | null;
  usdGte: number | null;
  usdLte: number | null;
  sortBy: "time" | "value" | "usd";
  sortDir: "asc" | "desc";
};

export type VisualizerState = {
  mode: "counterparty" | "token";
  /** For addresses, `value` is `chain:address`; for entities it is the entity id. */
  base: { type: "address" | "entity"; value: string; exclude: boolean }[];
  filter: VisualizerFilter;
  /** Epoch milliseconds */
  timeRange: { gte: number | null; lte: number | null };
  /** Legend groups hidden, keyed by node type key. */
  isHidden: Record<string, boolean>;
  /** Pinned nodes only. */
  positions: Record<string, XY>;
  /** Entity ids shown as individual addresses. */
  expanded: string[];
};

export type VisualizerView = {
  id: string;
  name: string;
  shareable: boolean;
  isOwner: boolean;
  state: VisualizerState;
  createdAt: string;
  updatedAt: string;
};

export type VisualizerViewSummary = {
  id: string;
  name: string;
  shareable: boolean;
  createdAt: string;
  updatedAt: string;
};

export type VisualizerOp = (
  | { type: "set_filter"; filter: VisualizerFilter }
  | { type: "set_time_range"; timeRange: VisualizerState["timeRange"] }
  | { type: "set_base"; base: VisualizerState["base"] }
  | { type: "set_is_hidden_for_type"; typeKey: string; isHiddenValue: boolean }
  | { type: "add_expanded"; nodeID: string }
  | { type: "remove_expanded"; nodeID: string }
  | { type: "set_position"; nodeID: string; position: XY }
  | { type: "delete_position"; nodeID: string }
  | { type: "set_name"; name: string }
  | { type: "set_shareable"; shareable: boolean }
) & { clientTimestamp: string };

export const DEFAULT_VISUALIZER_STATE: VisualizerState = {
  mode: "counterparty",
  base: [],
  filter: {
    flow: "all",
    from: null,
    to: null,
    tokens: null,
    chains: null,
    valueGte: null,
    valueLte: null,
    usdGte: 1,
    usdLte: null,
    sortBy: "time",
    sortDir: "desc",
  },
  timeRange: { gte: null, lte: null },
  isHidden: {},
  positions: {},
  expanded: [],
};
