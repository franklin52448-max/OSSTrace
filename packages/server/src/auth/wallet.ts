import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { verifyMessage } from "ethers";
import { nowIso } from "../lib/time.ts";

export type WalletChain = "solana" | "ethereum";

/** Lowercased for ethereum (checksum doesn't matter for matching); taken as-is (base58 is case-sensitive) for solana. */
export function normalizeAddress(chain: WalletChain, address: string): string {
  return chain === "ethereum" ? address.toLowerCase() : address;
}

export function isValidAddress(chain: WalletChain, address: string): boolean {
  if (chain === "ethereum") return /^0x[0-9a-fA-F]{40}$/.test(address);
  if (address.length < 32 || address.length > 44) return false;
  try {
    return bs58.decode(address).length === 32;
  } catch {
    return false;
  }
}

const CHALLENGE_TTL_MS = 5 * 60_000;

type PendingChallenge = { message: string; expiresAt: number };

/** In-memory, single-process (one Fly machine) — losing a pending challenge on restart just means the visitor retries. */
const pending = new Map<string, PendingChallenge>();

function key(chain: WalletChain, normalizedAddress: string): string {
  return `${chain}:${normalizedAddress}`;
}

function sweep(now: number) {
  if (pending.size < 1000) return;
  for (const [k, v] of pending) if (v.expiresAt <= now) pending.delete(k);
}

/** Creates (overwriting any prior pending one) a single-use, 5-minute challenge for this wallet. */
export function createChallenge(chain: WalletChain, address: string): string {
  const normalized = normalizeAddress(chain, address);
  const nonce = randomBytes(16).toString("hex");
  const message =
    `OSSTrace wants you to sign in with your ${chain === "solana" ? "Solana" : "Ethereum"} wallet.\n\n` +
    `Address: ${address}\n` +
    `Nonce: ${nonce}\n` +
    `Issued: ${nowIso()}`;
  const now = Date.now();
  sweep(now);
  pending.set(key(chain, normalized), { message, expiresAt: now + CHALLENGE_TTL_MS });
  return message;
}

/** Verifies `signature` over the pending challenge for this wallet, consuming it (single-use) either way. */
export function verifyChallenge(chain: WalletChain, address: string, signature: string): boolean {
  const normalized = normalizeAddress(chain, address);
  const k = key(chain, normalized);
  const entry = pending.get(k);
  pending.delete(k);
  if (!entry || entry.expiresAt <= Date.now()) return false;
  try {
    if (chain === "solana") return verifySolana(entry.message, signature, address);
    return verifyEthereum(entry.message, signature, address);
  } catch {
    return false;
  }
}

function verifySolana(message: string, signatureB64: string, address: string): boolean {
  const messageBytes = new TextEncoder().encode(message);
  const signatureBytes = Buffer.from(signatureB64, "base64");
  const publicKeyBytes = bs58.decode(address);
  if (publicKeyBytes.length !== 32) return false;
  return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
}

function verifyEthereum(message: string, signatureHex: string, address: string): boolean {
  const recovered = verifyMessage(message, signatureHex);
  return recovered.toLowerCase() === address.toLowerCase();
}

/** Only for tests: lets a test clear state between runs without waiting out the TTL. */
export function _resetChallengesForTests(): void {
  pending.clear();
}
