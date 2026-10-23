// Core domain types shared by the server and the web UI.

// "bnb" is BNB Smart Chain (EVM chain id 56). It shares Ethereum's address format and signature
// scheme, so one 0x address is the same account on both -- but its history, balances and labels are
// a separate chain's, so it's a separate `Chain`, never folded into "ethereum". Sign-in is a
// different question (see api.ts's `User.chain`): an Ethereum wallet signs in as "ethereum" and that
// same address is simply valid on BNB too, so there is deliberately no "bnb" login method.
//
// "robinhood" is Robinhood Chain (EVM chain id 4663), an Arbitrum Orbit L2 that settles to Ethereum.
// The same reasoning applies, with one more trap: its gas token is ETH itself, so a native transfer
// there says "ETH" exactly like one on Ethereum mainnet -- only the chain tells them apart, so it
// must never be folded into "ethereum". No "robinhood" login either, for the same reason as bnb.
//
// "base" is Base (Coinbase's OP Stack L2, EVM chain id 8453): the same shape again, gas paid in ETH
// too -- still its own `Chain` with its own history, and still no "base" login.
//
// Five more EVM chains, each read the same way (Alchemy's enhanced API) and each its own `Chain` for
// the same reasons, none with a login of its own:
// - "arbitrum": Arbitrum One (chain id 42161), gas paid in ETH.
// - "optimism": OP Mainnet (chain id 10), gas paid in ETH.
// - "zora": Zora (OP Stack L2, chain id 7777777), gas paid in ETH.
// - "lens": Lens Chain (a ZKsync-stack L2, chain id 232). Its gas token is GHO -- Aave's dollar
//   stablecoin, the chain's own native currency there -- not ETH.
// - "story": chain id 1514, launched as Story (native token IP) and since rebranded the Data Network
//   (native token DATA; chainid.network, CoinGecko and the chain's own foundation site all say so as of
//   2026-10). The id stays "story" -- the network's original name and Alchemy's own subdomain for it
//   (story-mainnet) -- while everything shown to a person says "Data Network" and "DATA".
//
// Three more, the same way again, none with a login of its own -- and none of them paying gas in ETH:
// - "gnosis": Gnosis Chain (formerly xDai, chain id 100). Its native currency is xDAI, a dollar
//   stablecoin (bridged DAI), not ETH.
// - "ronin": Ronin (chain id 2020), gas paid in RON, its own coin.
// - "rootstock": Rootstock (RSK, a Bitcoin sidechain, chain id 30). Gas is paid in RBTC ("Smart
//   Bitcoin", pegged 1:1 to BTC) -- its own EVM-native unit, priced as RBTC, never as Ethereum's ETH.
export type Chain = "solana" | "ethereum" | "bnb" | "robinhood" | "base" | "arbitrum" | "optimism" | "zora" | "lens" | "story" | "gnosis" | "ronin" | "rootstock";
export const CHAINS: readonly Chain[] = ["solana", "ethereum", "bnb", "robinhood", "base", "arbitrum", "optimism", "zora", "lens", "story", "gnosis", "ronin", "rootstock"] as const;
export const isChain = (v: unknown): v is Chain => typeof v === "string" && (CHAINS as readonly string[]).includes(v);

/** Display name per chain -- one place, so a new chain can't end up as "Solana" in a two-way ternary. */
export const CHAIN_NAMES: Record<Chain, string> = {
  solana: "Solana",
  ethereum: "Ethereum",
  bnb: "BNB Chain",
  robinhood: "Robinhood Chain",
  base: "Base",
  arbitrum: "Arbitrum One",
  optimism: "OP Mainnet",
  zora: "Zora",
  lens: "Lens Chain",
  story: "Data Network",
  gnosis: "Gnosis Chain",
  ronin: "Ronin",
  rootstock: "Rootstock",
};
/** Each chain's native unit, known without a successful balance call. Robinhood Chain's, Base's,
 *  Arbitrum One's, OP Mainnet's and Zora's really are ETH (bridged from Ethereum), not a token of their
 *  own -- so this symbol alone can't tell their transfers from Ethereum's; show the chain next to it.
 *  Lens Chain's is GHO and the Data Network's is DATA (formerly IP), each that chain's own. Gnosis
 *  Chain's is xDAI (a dollar stablecoin), Ronin's RON and Rootstock's RBTC (BTC-pegged). */
export const NATIVE_SYMBOLS: Record<Chain, string> = {
  solana: "SOL",
  ethereum: "ETH",
  bnb: "BNB",
  robinhood: "ETH",
  base: "ETH",
  arbitrum: "ETH",
  optimism: "ETH",
  zora: "ETH",
  lens: "GHO",
  story: "DATA",
  gnosis: "xDAI",
  ronin: "RON",
  rootstock: "RBTC",
};

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
  /** https URL of the token's logo from the balance or token-list provider; null when none is known (and for native). */
  logoUrl: string | null;
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
  /** Free-text name for this card, set on the trace itself (not a private label: it belongs to this
   *  trace document only, travels with it into a share, and never touches the labels table). */
  label?: string | null;
  /** Free-text investigator note on this card, same scope as `label`. */
  note?: string | null;
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
  | { type: "set_node_label"; id: string; label: string | null }
  | { type: "set_node_note"; id: string; note: string | null }
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
