import { formatUsd } from "./format.ts";

/** null renders as an em dash with a title explaining there was no price source. Never invents a value. */
export function UsdValue({ value }: { value: number | null | undefined }) {
  return (
    <span className="kit-num whitespace-nowrap" title={value == null ? "No price source for this token at that time" : undefined}>
      {formatUsd(value)}
    </span>
  );
}
