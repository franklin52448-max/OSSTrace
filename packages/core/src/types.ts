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

export interface TransactionSummary {
  chain: ChainId;
  hash: string;
  timestamp: string;
  from: string;
  to: string | null;
  /** Decimal string, native-token units. */
  valueNative: string;
  direction: "in" | "out" | "self";
}

/**
 * Chain adapters must distinguish "we checked, there's nothing" from "we couldn't check" —
 * never silently return an empty list for the latter.
 */
export type TransactionsResult =
  | { available: true; transactions: TransactionSummary[] }
  | { available: false; reason: string };
