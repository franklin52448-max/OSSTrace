import type { Address, ChainId } from "@osstrace/core";

/** The chains the Explorer serves. Must match what `buildRegistry` registers. */
export const SUPPORTED_CHAINS: readonly ChainId[] = ["ethereum", "solana"];

export function isSupportedChain(value: string): value is ChainId {
  return (SUPPORTED_CHAINS as readonly string[]).includes(value);
}

/**
 * One normalization rule for every entry point (HTTP lookup and websocket subscribe), so a
 * subscription and a lookup of the same address always land on the same popularity/cache key.
 * Ethereum addresses are case-insensitive hex (checksum casing is cosmetic), so they're
 * lowercased; Solana base58 is case-sensitive and is left exactly as given.
 */
export function normalizeAddress(chain: ChainId, raw: string): Address {
  const trimmed = raw.trim();
  return { chain, value: chain === "ethereum" ? trimmed.toLowerCase() : trimmed };
}
