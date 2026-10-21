import type { ChainId } from "./types.ts";

/**
 * The shape checks every feature needs before trusting an address string. Moved here from the
 * Visualizer once a second feature (community label submissions) needed exactly the same checks —
 * two copies of these regexes would drift.
 *
 * 1. `canonicalAddress` — Ethereum addresses are case-insensitive hex (Etherscan returns them
 *    lowercase, the label store stores them lowercase, a user may paste a checksummed one), so
 *    they're lowercased. Solana base58 IS case-sensitive, so it's left untouched.
 * 2. `isRealAddress` — a chain adapter's `from`/`to` field isn't always a real address. The Solana
 *    adapter, for transactions it can't decode into a plain transfer, honestly reports
 *    `"unresolved (non-transfer instruction)"` or `"unknown"` there instead of inventing a
 *    counterparty. Anything without the shape of a real address for its chain fails this check.
 *
 * Shape only: a well-formed address may still never have been used on-chain. If a third chain
 * lands, this file needs a line for it. (The better long-term home is the ChainAdapter interface
 * itself — e.g. an `isValidAddress` method.)
 */

const ETHEREUM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// Base58 alphabet (no 0, O, I, l); Solana public keys are 32 bytes => 32–44 base58 characters.
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function canonicalAddress(chain: ChainId, value: string): string {
  return chain === "ethereum" ? value.toLowerCase() : value;
}

export function isRealAddress(chain: ChainId, value: string | null): value is string {
  if (value === null) return false;
  switch (chain) {
    case "ethereum":
      return ETHEREUM_ADDRESS.test(value);
    case "solana":
      return SOLANA_ADDRESS.test(value);
  }
}

export const SUPPORTED_CHAINS: readonly ChainId[] = ["ethereum", "solana"];

export function isChainId(value: unknown): value is ChainId {
  return typeof value === "string" && (SUPPORTED_CHAINS as readonly string[]).includes(value);
}
