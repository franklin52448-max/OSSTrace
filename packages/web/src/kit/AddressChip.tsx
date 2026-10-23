import type { AddressInfo } from "@osstrace/contract";
import { ExternalLink } from "lucide-react";
import { explorerAddressUrl, explorerName } from "../explorers.ts";
import { CopyButton } from "./CopyButton.tsx";
import { IconButton } from "./Button.tsx";
import { addressDisplayName, shortAddress } from "./format.ts";

/** Name-first address display, with hover-revealed "copy address" / "view on <explorer>" actions
 * (kept out of the resting layout so this drops into dense table cells without changing their
 * width). Props are a contract used by shell and graph agents; styling may be refined by the
 * shell agent. */
export function AddressChip({ info, onClick, showHash = true, showActions = true }: { info: AddressInfo; onClick?: () => void; showHash?: boolean; showActions?: boolean }) {
  const name = addressDisplayName(info);
  const named = name !== shortAddress(info.address);
  const Tag = onClick ? "button" : "span";
  return (
    <span className="group inline-flex min-w-0 max-w-full items-baseline gap-1">
      <Tag
        type={onClick ? "button" : undefined}
        onClick={onClick}
        title={info.address}
        className={`inline-flex min-w-0 max-w-full items-baseline gap-1.5 text-left ${onClick ? "kit-fade rounded-sm hover:text-accent" : ""}`}
      >
        {named ? <span className="truncate font-medium">{name}</span> : <span className="kit-mono truncate">{name}</span>}
        {named && showHash ? <span className="kit-mono shrink-0 text-xs text-[var(--trace-text-faint)]">{shortAddress(info.address)}</span> : null}
      </Tag>
      {showActions ? (
        <span className="inline-flex shrink-0 items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
          <CopyButton value={info.address} label="Copy address" />
          <IconButton size="sm" label={`View on ${explorerName(info.chain)}`} onClick={() => window.open(explorerAddressUrl(info.chain, info.address), "_blank", "noopener")}>
            <ExternalLink aria-hidden className="size-3.5" />
          </IconButton>
        </span>
      ) : null}
    </span>
  );
}
