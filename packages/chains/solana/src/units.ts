/** Formats a lamport amount (always a safe-integer number from web3.js) as a decimal SOL string. */
export function lamportsToSol(lamports: number): string {
  const raw = BigInt(Math.trunc(lamports));
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 1_000_000_000n;
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(9, "0").replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return frac.length > 0 ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}

/**
 * Formats a raw SPL token amount (an unsigned integer string, as the RPC reports it — token
 * amounts are u64 and can exceed Number.MAX_SAFE_INTEGER) at the token's real decimals.
 */
export function formatTokenAmount(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`not an unsigned integer token amount: ${raw}`);
  }
  const value = BigInt(raw);
  if (decimals === 0) return value.toString();
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
}
