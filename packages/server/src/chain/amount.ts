/** amountRaw / 10^decimals as an exact decimal string (no floats). */
export function formatUnits(raw: string, decimals: number | null): string {
  if (!/^-?\d+$/.test(raw)) return "0";
  if (!decimals || decimals <= 0) return BigInt(raw).toString();
  const neg = raw.startsWith("-");
  const digits = BigInt(neg ? raw.slice(1) : raw).toString().padStart(decimals + 1, "0");
  const int = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? "." + frac : ""}`;
}

export const isPositiveIntString = (s: unknown): s is string => typeof s === "string" && /^\d+$/.test(s) && !/^0+$/.test(s);
