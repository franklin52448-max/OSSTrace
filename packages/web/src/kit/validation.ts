import { CHAIN_NAMES, isEvmChain, type Chain } from "@osstrace/contract";

export const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;
export const PASSWORD_MIN = 10;

export function validateUsername(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (!v) return "Enter a username.";
  if (v.length < 3) return "Username must be at least 3 characters.";
  if (v.length > 32) return "Username must be at most 32 characters.";
  if (!USERNAME_RE.test(v)) return "Use only letters, digits, dot, dash and underscore.";
  return null;
}

export function validatePassword(v: string): string | null {
  if (!v) return "Enter a password.";
  if (v.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  return null;
}

export const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const SOL_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function validateAddress(chain: Chain, raw: string): string | null {
  const v = raw.trim();
  if (!v) return "Enter an address.";
  // "an Ethereum", "an Arbitrum One", "an OP Mainnet" -- every chain name starting with a vowel.
  if (isEvmChain(chain) && !ETH_ADDRESS_RE.test(v)) return `Not ${/^[AEIOU]/.test(CHAIN_NAMES[chain]) ? "an" : "a"} ${CHAIN_NAMES[chain]} address (0x followed by 40 hex characters).`;
  if (chain === "solana" && !SOL_ADDRESS_RE.test(v)) return "Not a Solana address (32 to 44 base58 characters).";
  return null;
}

export function validateWebhookUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "Enter a URL.";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "Not a valid URL.";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "Webhook URLs must start with http:// or https://.";
  return null;
}

export { CHAIN_NAMES };
