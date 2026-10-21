import type { ChainId } from "@opentrace/core";

/**
 * The only chain-aware code in this package, and deliberately tiny. Two jobs:
 *
 * 1. `canonicalAddress` — Ethereum addresses are case-insensitive hex (Etherscan returns them
 *    lowercase, the label store stores them lowercase, a user may paste a checksummed one), so
 *    they're lowercased before being used as a node id. Solana base58 IS case-sensitive, so it's
 *    left untouched.
 * 2. `isRealAddress` — a chain adapter's `from`/`to` field isn't always a real address. The Solana
 *    adapter, for transactions it can't decode into a plain transfer, honestly reports
 *    `"unresolved (non-transfer instruction)"` or `"unknown"` there instead of inventing a
 *    counterparty. Those must never become graph nodes, so anything that doesn't have the shape
 *    of a real address for its chain is treated as "counterparty unresolved".
 *
 * If a third chain lands, this is the one file in the Visualizer that needs a line for it. (The
 * better long-term home for both checks is the ChainAdapter interface itself — e.g. an
 * `isValidAddress` method — which would make this file disappear; not done here because changing
 * a core interface is out of scope for this feature.)
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
