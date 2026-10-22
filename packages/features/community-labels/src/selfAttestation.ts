import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import bs58 from "bs58";
import { canonicalAddress, isRealAddress, type AccountId, type AttestationScheme, type ChainId } from "@osstrace/core";

/**
 * Self-attested labels (ADR 0004 tier 3, ADR 0019): the submitter signs a server-issued statement
 * with the key that controls the address, and the server checks that signature.
 *
 * Signature checks use `@noble/curves` + `@noble/hashes` (audited, the libraries
 * `@solana/web3.js` itself is built on, already in this monorepo through it) and `bs58` (the base58
 * codec `@solana/web3.js` uses). Nothing here is hand-rolled cryptography: this file only builds
 * the exact bytes each standard scheme signs and hands them to those libraries.
 */

export function schemeFor(chain: ChainId): AttestationScheme {
  return chain === "ethereum" ? "eip191-personal-sign" : "solana-ed25519";
}

/** EIP-191 version 0x45 (`personal_sign`): keccak256("\x19Ethereum Signed Message:\n" + len + message). */
export function eip191Hash(message: string): Uint8Array {
  const body = utf8ToBytes(message);
  return keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${body.length}`), body));
}

/** The Ethereum address of an uncompressed secp256k1 public key: last 20 bytes of keccak256(x‖y), lowercase. */
export function ethereumAddressOf(uncompressedPublicKey: Uint8Array): string {
  return `0x${bytesToHex(keccak_256(uncompressedPublicKey.subarray(1)).subarray(-20))}`;
}

function verifyEthereum(address: string, message: string, signature: string): boolean {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  const bytes = hexToBytes(signature.slice(2));
  const v = bytes[64]!;
  // Wallets return v as 27/28 (legacy) or 0/1. Anything else isn't a personal_sign signature.
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) return false;
  const sig = secp256k1.Signature.fromCompact(bytes.subarray(0, 64));
  // A high-s signature is the malleated twin of a valid one. Real wallets never produce it.
  if (sig.hasHighS()) return false;
  const publicKey = sig.addRecoveryBit(recovery).recoverPublicKey(eip191Hash(message)).toRawBytes(false);
  return ethereumAddressOf(publicKey) === canonicalAddress("ethereum", address);
}

function verifySolana(address: string, message: string, signature: string): boolean {
  const publicKey = bs58.decode(address);
  const sig = bs58.decode(signature);
  if (publicKey.length !== 32 || sig.length !== 64) return false;
  return ed25519.verify(sig, utf8ToBytes(message), publicKey);
}

/**
 * True only if `signature` is a valid signature over exactly `message` by the key that controls
 * `address` on `chain`:
 *
 * - **ethereum**: EIP-191 `personal_sign`. The public key is recovered from the 65-byte r‖s‖v
 *   signature and its address must equal `address`. Only EOAs: a smart-contract wallet (a Safe)
 *   signs through EIP-1271, which needs a chain call and isn't supported (ADR 0019).
 * - **solana**: Ed25519 over the message's UTF-8 bytes, against the 32-byte public key that *is*
 *   the base58 address. Signature in base58.
 *
 * Never throws: any malformed input (bad hex, bad base58, a point not on the curve) is `false`.
 */
export function verifySelfAttestation(chain: ChainId, address: string, message: string, signature: string): boolean {
  if (typeof address !== "string" || typeof message !== "string" || typeof signature !== "string") return false;
  if (!isRealAddress(chain, address)) return false;
  try {
    return chain === "ethereum" ? verifyEthereum(address, message, signature) : verifySolana(address, message, signature);
  } catch {
    return false;
  }
}

/** Everything the signed statement commits to. */
export interface AttestationStatement {
  domain: string;
  chain: ChainId;
  /** Canonical form. */
  address: string;
  /** Already validated as one line of plain text, so it can't inject extra lines into the statement. */
  name: string;
  accountId: AccountId;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

/**
 * The exact text the wallet is asked to sign. Plain, line-per-field, readable in a wallet's
 * signing prompt (the same idea as Sign-In with Ethereum, EIP-4361): the person can see which
 * address, which label, which site and which account they're vouching for. It's built only by the
 * server from a challenge it issued. A client never supplies the message, so it can't be swapped.
 */
export function buildAttestationMessage(s: AttestationStatement): string {
  return [
    `${s.domain} wants you to self-attest a public label for an address you control.`,
    "",
    "I control this address, and I publicly label it as shown below. This is not a transaction and costs nothing.",
    "",
    `Chain: ${s.chain}`,
    `Address: ${s.address}`,
    `Label: ${s.name}`,
    `OSSTrace account: ${s.accountId}`,
    `Nonce: ${s.nonce}`,
    `Issued At: ${s.issuedAt}`,
    `Expiration Time: ${s.expiresAt}`,
  ].join("\n");
}

/** How long a challenge can be signed for. Long enough to open a wallet; short enough not to linger. */
export const CHALLENGE_TTL_MS = 10 * 60 * 1000;
/** Unexpired challenges one account may hold. Requesting another drops that account's oldest. */
export const CHALLENGES_PER_ACCOUNT = 5;
/** Hard cap across all accounts, so issuing challenges can't grow memory without bound. */
export const MAX_OUTSTANDING_CHALLENGES = 10_000;

export interface Challenge extends AttestationStatement {
  message: string;
}

export type RedeemOutcome = { ok: true; challenge: Challenge } | { ok: false; reason: "unknown" | "expired" };

/**
 * Issued, not-yet-used challenges, in memory. A challenge is single-use (redeeming it removes it,
 * whether or not the signature then checks out), expires after `CHALLENGE_TTL_MS`, and can only be
 * redeemed by the account it was issued to. Losing them on restart is fine: the person just asks
 * for a new one. Nothing here is a secret worth persisting.
 */
export class ChallengeBook {
  readonly #byNonce = new Map<string, Challenge>();

  issue(statement: Omit<AttestationStatement, "nonce" | "issuedAt" | "expiresAt">, now: Date): Challenge {
    this.#sweep(now);
    const mine = [...this.#byNonce.values()].filter((c) => c.accountId === statement.accountId);
    for (const old of mine.slice(0, Math.max(0, mine.length - CHALLENGES_PER_ACCOUNT + 1))) this.#byNonce.delete(old.nonce);
    if (this.#byNonce.size >= MAX_OUTSTANDING_CHALLENGES) {
      const oldest = this.#byNonce.keys().next().value;
      if (oldest !== undefined) this.#byNonce.delete(oldest);
    }
    const full: AttestationStatement = {
      ...statement,
      nonce: randomBytes(16).toString("hex"),
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString(),
    };
    const challenge: Challenge = { ...full, message: buildAttestationMessage(full) };
    this.#byNonce.set(challenge.nonce, challenge);
    return challenge;
  }

  /** Takes the challenge out (single use). Another account's nonce is `unknown` and left in place. */
  redeem(nonce: unknown, accountId: AccountId, now: Date): RedeemOutcome {
    if (typeof nonce !== "string") return { ok: false, reason: "unknown" };
    const challenge = this.#byNonce.get(nonce);
    if (!challenge || challenge.accountId !== accountId) return { ok: false, reason: "unknown" };
    this.#byNonce.delete(nonce);
    if (Date.parse(challenge.expiresAt) <= now.getTime()) return { ok: false, reason: "expired" };
    return { ok: true, challenge };
  }

  #sweep(now: Date): void {
    for (const [nonce, c] of this.#byNonce) {
      if (Date.parse(c.expiresAt) <= now.getTime()) this.#byNonce.delete(nonce);
    }
  }
}
