import type { Chain } from "@osstrace/contract";
import { useState } from "react";
import { ChainIcon } from "../ChainSelect.tsx";
import { cn } from "./cn.ts";

/**
 * A token's logo: the chain mark for the native asset, the provider's image for a token, or the
 * symbol's first letter on a disc when there is no image or it fails to load. Images come from
 * third-party hosts, so no referrer is sent.
 */
export function TokenLogo({ chain, tokenId, symbol, logoUrl, size = 20, className }: { chain: Chain; tokenId: string; symbol: string | null; logoUrl: string | null; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const box = { width: size, height: size };
  if (tokenId === "native") {
    return (
      <span style={box} className={cn("inline-flex shrink-0 items-center justify-center rounded-full bg-surface-2", className)} aria-hidden="true">
        <ChainIcon chain={chain} size={Math.round(size * 0.62)} />
      </span>
    );
  }
  if (logoUrl && !failed) {
    return (
      <img
        src={logoUrl}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        style={box}
        className={cn("shrink-0 rounded-full bg-surface-2 object-cover", className)}
      />
    );
  }
  return (
    <span
      style={{ ...box, fontSize: Math.round(size * 0.45) }}
      className={cn("kit-mono inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-surface-2 font-medium uppercase text-muted", className)}
      aria-hidden="true"
    >
      {symbol?.trim().charAt(0) || "?"}
    </span>
  );
}
