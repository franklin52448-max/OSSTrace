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

/** `host` is the signing dApp's own domain (the already-CORS/CSRF-validated request Origin, with the
 * scheme stripped) -- it's EIP-4361's `domain` field, which MetaMask/other wallets' phishing and
 * message-trust heuristics check against the site that's actually asking. A plain, non-standard
 * message (what this used to send) renders as a generic "unusual request" in some wallets even for
 * a perfectly legitimate sign-in; a spec-correct SIWE message gets their dedicated sign-in UI instead. */
function buildEthereumMessage(host: string, address: string, uri: string, nonce: string, issuedAt: string): string {
  return (
    `${host} wants you to sign in with your Ethereum account:\n` +
    `${address}\n\n` +
    `Sign in to OSSTrace.\n\n` +
    `URI: ${uri}\n` +
    `Version: 1\n` +
    `Chain ID: 1\n` +
    `Nonce: ${nonce}\n` +
    `Issued At: ${issuedAt}`
  );
}

/** Creates (overwriting any prior pending one) a single-use, 5-minute challenge for this wallet.
 * `origin` is this request's already-validated Origin (e.g. "https://opensourcetrace.org") -- used
 * as EIP-4361's domain/uri for Ethereum. Solana has no equivalent wallet-trust benefit from message
 * formatting alone (see wallet.ts's module comment / the auth commit this came from for why), so its
 * message keeps its prior plain-text shape. */
export function createChallenge(chain: WalletChain, address: string, origin: string): string {
  const normalized = normalizeAddress(chain, address);
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = nowIso();
  const host = origin.replace(/^https?:\/\//, "");
  const message =
    chain === "ethereum"
      ? buildEthereumMessage(host, address, origin, nonce, issuedAt)
      : `OSSTrace wants you to sign in with your Solana wallet.\n\n` +
        `Address: ${address}\n` +
        `Nonce: ${nonce}\n` +
        `Issued: ${issuedAt}`;
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
