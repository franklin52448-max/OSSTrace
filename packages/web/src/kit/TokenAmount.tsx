import { formatAmount } from "./format.ts";

export function TokenAmount({ amount, symbol }: { amount: string; symbol?: string | null }) {
  return (
    <span className="kit-num whitespace-nowrap" title={`${amount}${symbol ? ` ${symbol}` : ""}`}>
      {formatAmount(amount)}
      {symbol ? <span className="ml-1 text-[var(--trace-text-muted)]">{symbol}</span> : null}
    </span>
  );
}
