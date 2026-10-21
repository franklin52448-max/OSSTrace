import type { ChainId } from "@osstrace/core";

export const SUPPORTED_CHAINS: readonly ChainId[] = ["ethereum", "solana"];

export function isChainId(value: unknown): value is ChainId {
  return typeof value === "string" && (SUPPORTED_CHAINS as readonly string[]).includes(value);
}

const ETHEREUM_ADDRESS = /^0x[0-9a-f]{40}$/;
// Base58 (no 0, O, I, l); a 32-byte Solana public key encodes to 32–44 characters.
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * The one canonical form a private label is stored and looked up under, so "my cold wallet" is
 * found no matter how the address was pasted:
 *
 * - **Ethereum**: lowercased. Hex case is only an EIP-55 checksum, not part of the address — the
 *   same choice the Explorer API makes (`explorer/src/server.ts`), so the address the web UI shows
 *   and the one a label was saved under always agree.
 * - **Solana**: exact. Base58 is case-sensitive; changing case would name a different account.
 *
 * Returns null for anything that isn't a well-formed address on that chain, so a typo can't quietly
 * become a label on an address nobody will ever look up.
 */
export function canonicalAddress(chain: ChainId, raw: string): string | null {
  const trimmed = raw.trim();
  if (chain === "ethereum") {
    const lower = trimmed.toLowerCase();
    return ETHEREUM_ADDRESS.test(lower) ? lower : null;
  }
  return SOLANA_ADDRESS.test(trimmed) ? trimmed : null;
}
