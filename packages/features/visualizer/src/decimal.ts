/**
 * Exact addition of non-negative decimal strings ("1.5" + "0.000000001" = "1.500000001").
 * Chain adapters report amounts as decimal strings on purpose (core's `Balance`/`TransactionSummary`
 * docs: "never a float"), so per-node totals are summed with BigInt instead of `Number`, which
 * would silently lose precision on 18-decimal Ethereum amounts.
 */
export function addDecimal(a: string, b: string): string {
  const [aInt = "0", aFrac = ""] = a.split(".");
  const [bInt = "0", bFrac = ""] = b.split(".");
  const scale = Math.max(aFrac.length, bFrac.length);
  const aScaled = BigInt((aInt || "0") + aFrac.padEnd(scale, "0"));
  const bScaled = BigInt((bInt || "0") + bFrac.padEnd(scale, "0"));
  const sum = (aScaled + bScaled).toString().padStart(scale + 1, "0");
  if (scale === 0) return sum;
  const intPart = sum.slice(0, sum.length - scale);
  const fracPart = sum.slice(sum.length - scale).replace(/0+$/, "");
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

/** True for any decimal string `addDecimal` can handle (non-negative, digits with an optional fraction). */
export function isDecimalString(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value);
}
