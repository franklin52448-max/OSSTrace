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
