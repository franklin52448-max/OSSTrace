/**
 * Exact decimal-string arithmetic for on-chain amounts, entirely in BigInt -- never `Number`/floating
 * point, so an amount is never silently rounded the way IEEE-754 would round e.g. 0.1 + 0.2.
 *
 * Kept free of any chain SDK import on purpose: the bounty board list (BountiesView) sums and
 * compares deposits per asset on every page load, and must not drag @solana/web3.js into the main
 * chunk the way importing these from wallets.ts would (wallets.ts re-exports them for its own
 * existing callers).
 */

/**
 * A human-typed decimal amount ("0.05", "1001") parsed into its exact raw integer at a given
 * number of decimals. Mirrors the inverse of `@osstrace/chain-ethereum`'s `formatUnits` on the
 * read side.
 */
export function parseDecimalAmount(amountHuman: string, decimals: number): bigint {
  const trimmed = amountHuman.trim();
  if (trimmed.startsWith("-")) throw new Error("amount must not be negative");
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") throw new Error("not a valid amount");
  const [whole = "0", frac = ""] = trimmed.split(".");
  if (frac.length > decimals) throw new Error(`this asset only has ${decimals} decimal place${decimals === 1 ? "" : "s"}`);
  const digits = `${whole}${frac.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
  return BigInt(digits === "" ? "0" : digits);
}

const fractionDigits = (amount: string): number => (amount.split(".")[1] ?? "").length;

/**
 * Adds already-formatted decimal-string amounts (as `Deposit.amount` comes from the API) -- used
 * only to show a per-asset running total on the board. Decimals are inferred per call from however
 * many fractional digits the real amounts carry.
 */
export function sumDecimalAmounts(amounts: string[]): string {
  const decimals = Math.max(0, ...amounts.map(fractionDigits));
  const total = amounts.reduce((sum, a) => sum + parseDecimalAmount(a, decimals), 0n);
  const s = total.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals) || "0";
  const frac = decimals > 0 ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : whole;
}

/** Exact comparison of two decimal-string amounts of the SAME asset: negative, zero or positive. */
export function compareDecimalAmounts(a: string, b: string): number {
  const decimals = Math.max(fractionDigits(a), fractionDigits(b));
  const x = parseDecimalAmount(a, decimals);
  const y = parseDecimalAmount(b, decimals);
  return x < y ? -1 : x > y ? 1 : 0;
}
