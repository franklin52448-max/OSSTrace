import { keccak_256 } from "@noble/hashes/sha3";
import { v5 as uuidv5 } from "uuid";
import type { Chain } from "./types.ts";

/** OSSTrace's own UUIDv5 namespace — never reuse another project's, or ids from two projects could collide. */
export const ID_NAMESPACE = "d30e382d-2a7e-40e4-bbac-d8452ee0e497";

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** EIP-55 checksum address. Input must be 0x + 40 hex chars (any case). */
export function toChecksumAddress(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(lower)) throw new Error(`not an EVM address: ${address}`);
  const hash = hex(keccak_256(new TextEncoder().encode(lower)));
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  return out;
}

export const isEvmAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s.trim());
/** Solana addresses are base58, 32 bytes => 32-44 chars. */
export const isSolanaAddress = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim());

/** The chains whose addresses are 0x + 40 hex (secp256k1, EIP-55): one address is the same account on each. */
export const EVM_CHAINS: readonly Chain[] = ["ethereum", "bnb", "robinhood"] as const;
export const isEvmChain = (chain: Chain): boolean => EVM_CHAINS.includes(chain);

/**
 * The chain an address's *shape* implies, for a bare paste with nothing else to go on. A 0x address
 * is equally valid on every EVM chain, so this answers "ethereum" as the default, never "the" chain:
 * anything that already knows which chain it means must check `isAddressOnChain(chain, s)` instead
 * of comparing against this, or every BNB address would be rejected as "not a BNB address".
 */
export function detectChain(s: string): Chain | null {
  const t = s.trim();
  if (isEvmAddress(t)) return "ethereum";
  if (isSolanaAddress(t)) return "solana";
  return null;
}

/** True when `s` is a well-formed address for `chain` (shape only, nothing on-chain is checked). */
export function isAddressOnChain(chain: Chain, s: string): boolean {
  return isEvmChain(chain) ? isEvmAddress(s) : isSolanaAddress(s);
}

/** The chain to read a pasted address on: `preferred` (the picker's current choice) whenever the
 *  address is valid there -- so a 0x paste into a BNB picker stays on BNB -- else its shape's default. */
export function chainForAddress(s: string, preferred?: Chain | null): Chain | null {
  if (preferred && isAddressOnChain(preferred, s)) return preferred;
  return detectChain(s);
}

/** Canonical form used for storage and ids: EVM checksummed, Solana trimmed (case-sensitive). */
export function normalizeAddress(chain: Chain, address: string): string {
  const t = address.trim();
  return isEvmChain(chain) ? toChecksumAddress(t) : t;
}

export const addressNodeId = (traceId: string, chain: Chain, address: string) =>
  uuidv5(`trace:${traceId}:node:address:${chain}:${normalizeAddress(chain, address)}`, ID_NAMESPACE);

export const entityNodeId = (traceId: string, entityId: string) =>
  uuidv5(`trace:${traceId}:node:entity:${entityId}`, ID_NAMESPACE);

export const transactionNodeId = (traceId: string, chain: Chain, hash: string) =>
  uuidv5(`trace:${traceId}:node:transaction:${chain}:${hash}`, ID_NAMESPACE);

/** Direction-independent: one aggregate edge per unordered node pair. */
export const aggregateEdgeId = (traceId: string, nodeA: string, nodeB: string) =>
  uuidv5(`trace:${traceId}:edge:aggregate:${[nodeA, nodeB].sort().join(":")}`, ID_NAMESPACE);

export const transferEdgeId = (traceId: string, chain: Chain, transferId: string) =>
  uuidv5(`trace:${traceId}:edge:transfer:${chain}:${transferId}`, ID_NAMESPACE);
