/**
 * The shared data model. Every chain adapter and feature package imports from here and nowhere
 * else defines these shapes — see ARCHITECTURE.md.
 */

/**
 * The set of chains this build knows about. Adding a chain means adding its id here AND a
 * matching package under packages/chains/<chain>/ — see packages/chains/README.md.
 */
export type ChainId = "ethereum" | "solana";

export interface Address {
  chain: ChainId;
  /** Chain-native format (checksummed hex for Ethereum, base58 for Solana) — never normalized. */
  value: string;
}

/** Stable string key for an Address, for use as a Map/store key. */
export function addressKey(address: Address): string {
  return `${address.chain}:${address.value}`;
}

/**
 * Required on every Label and Tag — see ADR 0002. There is no way to construct a Label or Tag
 * without one; this is the enforcement mechanism, not just a convention.
 */
export interface Source {
  /** What this is, or the methodology used, in plain language. */
  description: string;
  /** A checkable URL — an external document, or a path to this repo's own methodology doc. */
  url: string;
  /** ISO 8601 date this entry was added. */
  addedAt: string;
}

export type Confidence = "verified" | "predicted";

/** At most one Label per Address (mirrors the model confirmed from Arkham's public API docs). */
export interface Label {
  address: Address;
  name: string;
  confidence: Confidence;
  source: Source;
}

/** Independent of labeling — an address can be tagged without being labeled. */
export interface Tag {
  address: Address;
  tag: string;
  source: Source;
}

/** A real-world actor; its addresses can span multiple chains. */
export interface Entity {
  id: string;
  name: string;
  addresses: Address[];
  source: Source;
}

export interface Balance {
  chain: ChainId;
  address: string;
  native: {
    symbol: string;
    /** Decimal string, never a float — avoids precision loss on large/small amounts. */
    amount: string;
    decimals: number;
  };
  asOf: string;
}

export type TransferDirection = "in" | "out" | "self";

/**
 * One fungible-token movement inside a transaction (an ERC-20 `Transfer` on Ethereum, an SPL
 * Token `transfer`/`transferChecked` on Solana), decoded from real chain data. Every field that
 * couldn't actually be resolved from the data source is `null` — never guessed.
 */
export interface TokenTransfer {
  /** The token's on-chain identity: ERC-20 contract address, or SPL mint. `null` if unresolved. */
  token: string | null;
  /** As reported by the data source (Etherscan for ERC-20). `null` when the source doesn't say. */
  symbol: string | null;
  name: string | null;
  /** The token's real decimals, from the data source — `null` if it couldn't be resolved. */
  decimals: number | null;
  /** Integer string in the token's smallest unit — always present, exactly as decoded. */
  rawAmount: string;
  /** Decimal string (`rawAmount` scaled by `decimals`), or `null` when `decimals` is unknown. */
  amount: string | null;
  /** The holder the tokens left / arrived at (Solana: the token account's owner). `null` if unresolved. */
  from: string | null;
  to: string | null;
  /** Solana only: the SPL token accounts actually debited/credited (always known when decoded). */
  fromTokenAccount?: string;
  toTokenAccount?: string;
  /** Relative to the queried address. */
  direction: TransferDirection;
}

export interface TransactionSummary {
  chain: ChainId;
  hash: string;
  timestamp: string;
  from: string;
  to: string | null;
  /** Decimal string, native-token units. */
  valueNative: string;
  direction: TransferDirection;
  /**
   * Token movements in this transaction that involve the queried address, when the adapter
   * decodes them. Absent (not an empty array) when the adapter decoded none, so existing
   * native-only consumers see exactly the shape they always did. See each chain's README for how
   * its top-level `from`/`to`/`valueNative` relate to these.
   */
  tokenTransfers?: TokenTransfer[];
}

/**
 * Chain adapters must distinguish "we checked, there's nothing" from "we couldn't check" —
 * never silently return an empty list for the latter.
 */
export type TransactionsResult =
  | { available: true; transactions: TransactionSummary[] }
  | { available: false; reason: string };
