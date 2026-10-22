import type { AddressInfo } from "@osstrace/contract";
import { addressDisplayName, shortAddress } from "./format.ts";

/** Name-first address display. Props are a contract used by shell and graph agents; styling may be refined by the shell agent. */
export function AddressChip({ info, onClick, showHash = true }: { info: AddressInfo; onClick?: () => void; showHash?: boolean }) {
  const name = addressDisplayName(info);
  const named = name !== shortAddress(info.address);
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      title={info.address}
      className={`inline-flex min-w-0 max-w-full items-baseline gap-1.5 text-left ${onClick ? "kit-fade rounded-sm hover:text-accent" : ""}`}
    >
      {named ? <span className="truncate font-medium">{name}</span> : <span className="kit-mono truncate">{name}</span>}
      {named && showHash ? <span className="kit-mono shrink-0 text-xs text-[var(--trace-text-faint)]">{shortAddress(info.address)}</span> : null}
    </Tag>
  );
}
