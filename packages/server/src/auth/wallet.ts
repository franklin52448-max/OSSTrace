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
/** Hard ceiling on live pending challenges, so memory stays bounded even under a challenge flood
 * spread across many IPs (each IP is already capped at 10/hour -- see throttle.ts). Reaching it
 * evicts the oldest; with a 5-minute TTL that takes ~50k fresh challenges inside 5 minutes, and
 * even then it's untargeted -- nobody can single out one wallet's in-flight sign-in this way. */
const MAX_PENDING = 50_000;

type PendingChallenge = { chain: WalletChain; normalizedAddress: string; message: string; expiresAt: number };

/**
 * Keyed by the challenge's own random nonce (the same one already embedded in the signed message's
 * `Nonce:` line), never by wallet address. Keying by `chain:address` meant one pending challenge per
 * wallet, so anyone who knew an address could request a fresh challenge for it and silently
 * invalidate whatever challenge its real owner was mid-way through signing -- repeated, that locked
 * the owner out of signing in at all. With a nonce key, each requester only ever consumes the
 * challenge they themselves were handed; requesting another for the same address no longer touches
 * anyone else's.
 *
 * In-memory, single-process (one Fly machine) -- losing a pending challenge on restart just means
 * the visitor retries.
 */
const pending = new Map<string, PendingChallenge>();

function sweep(now: number) {
  if (pending.size < 1000) return;
  for (const [k, v] of pending) if (v.expiresAt <= now) pending.delete(k);
  // Map iteration is insertion order, so the first keys are the oldest.
  for (const k of pending.keys()) {
    if (pending.size < MAX_PENDING) break;
    pending.delete(k);
  }
}

/** A nonce as createChallenge mints it: 16 random bytes, hex. */
export const CHALLENGE_NONCE_FORMAT = /^[0-9a-f]{32}$/;

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

/** Sign-In With Solana (SIWS) text format -- the same shape phantom/Solflare already parse and
 * check the requesting site's domain against, mirroring what EIP-4361 gets Ethereum. The prior
 * plain-text message (no domain field at all) let a phishing site's own backend request a real
 * challenge for a victim's address from this server, show it to the victim on the phishing domain
 * with nothing looking wrong, and take the resulting signature straight to this server's real
 * /api/auth/verify to log in as them -- the wallet had no domain to compare, so it showed no
 * mismatch warning. A SIWS-format message fixes the domain into the signed text itself, so a
 * wallet that supports it warns when the signing site doesn't match. */
function buildSolanaMessage(host: string, address: string, uri: string, nonce: string, issuedAt: string): string {
  return (
    `${host} wants you to sign in with your Solana account:\n` +
    `${address}\n\n` +
    `Sign in to OSSTrace.\n\n` +
    `URI: ${uri}\n` +
    `Version: 1\n` +
    `Chain ID: mainnet\n` +
    `Nonce: ${nonce}\n` +
    `Issued At: ${issuedAt}`
  );
}

/** Creates a single-use, 5-minute challenge for this wallet, alongside (never replacing) any other
 * pending ones for the same wallet. Returns the message to sign and its nonce, which the client
 * sends back to /api/auth/verify to say which challenge it signed. `origin` is this request's
 * already-validated Origin (e.g. "https://opensourcetrace.org") -- used as EIP-4361's domain/uri for
 * Ethereum, and the equivalent SIWS fields for Solana. */
export function createChallenge(chain: WalletChain, address: string, origin: string): { message: string; nonce: string } {
  const normalized = normalizeAddress(chain, address);
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = nowIso();
  const host = origin.replace(/^https?:\/\//, "");
  const message = chain === "ethereum" ? buildEthereumMessage(host, address, origin, nonce, issuedAt) : buildSolanaMessage(host, address, origin, nonce, issuedAt);
  const now = Date.now();
  sweep(now);
  pending.set(nonce, { chain, normalizedAddress: normalized, message, expiresAt: now + CHALLENGE_TTL_MS });
  return { message, nonce };
}

/** Verifies `signature` over the pending challenge `nonce` names, consuming it (single-use) either
 * way. The challenge must also have been issued for this same chain and address -- a nonce minted
 * for one wallet can't be spent signing in as another, even with a valid signature from that other
 * wallet. */
export function verifyChallenge(chain: WalletChain, address: string, nonce: string, signature: string): boolean {
  const entry = pending.get(nonce);
  pending.delete(nonce);
  if (!entry || entry.expiresAt <= Date.now()) return false;
  if (entry.chain !== chain || entry.normalizedAddress !== normalizeAddress(chain, address)) return false;
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
