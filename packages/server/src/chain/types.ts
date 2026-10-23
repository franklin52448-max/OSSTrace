import type { Chain } from "@osstrace/contract";
import type { Budget } from "../lib/http.ts";

/** A transfer as normalized from a provider, before USD pricing and label joins. */
export type RawTransfer = {
  chain: Chain;
  id: string;
  txHash: string;
  blockNumber: number;
  /** epoch seconds */
  blockTime: number;
  from: string;
  to: string;
  fromOwner: string | null;
  toOwner: string | null;
  tokenId: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  tokenDecimals: number | null;
  tokenStandard: "native" | "erc20" | "erc721" | "erc1155" | "spl";
  amountRaw: string;
  /** DefiLlama coin key used for pricing, null when the asset has no fungible price (NFTs). */
  priceCoin: string | null;
};

export type StreamPage = {
  transfers: RawTransfer[];
  /** Cursor for the next (older) page, null when the history is exhausted. */
  nextCursor: string | null;
  /** Oldest / newest block time (epoch s) of the underlying items in this page (null when empty). */
  oldestTime: number | null;
  newestTime: number | null;
  /** Coverage caveat for this page (e.g. some token accounts not followed); surfaces as sync "partial". */
  note?: string;
};

export type RawBalance = {
  tokenId: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  amountRaw: string;
  priceCoin: string | null;
  /** https logo URL when the provider supplies one. */
  logoUrl?: string | null;
};

export interface ChainProvider {
  readonly chain: Chain;
  /** Short id used in errors and SyncStatus.provider (never contains a URL or key). */
  readonly id: string;
  readonly name: string;
  /** Independent newest-first histories that together make up an address's transfers. */
  streams(): string[];
  fetchStreamPage(address: string, stream: string, cursor: string | null, budget: Budget): Promise<StreamPage>;
  /** Combined page over all streams (SPEC interface). `before` is an opaque cursor from a previous call. */
  fetchTransfers(address: string, opts: { before?: string | null; budget: Budget }): Promise<{ transfers: RawTransfer[]; nextCursor: string | null }>;
  fetchBalances(address: string, budget: Budget): Promise<RawBalance[]>;
  ping(): Promise<{ ok: boolean; note?: string }>;
}

/** Combine one page from each stream into the SPEC's single-cursor `fetchTransfers`. */
export async function combinedFetch(
  p: Pick<ChainProvider, "streams" | "fetchStreamPage">,
  address: string,
  before: string | null | undefined,
  budget: Budget,
): Promise<{ transfers: RawTransfer[]; nextCursor: string | null }> {
  const state: Record<string, string | null> = before ? JSON.parse(Buffer.from(before, "base64url").toString("utf8")) : {};
  const streams = p.streams().filter((s) => !(s in state) || state[s] !== null);
  const pages = await Promise.all(streams.map((s) => p.fetchStreamPage(address, s, state[s] ?? null, budget)));
  const next: Record<string, string | null> = { ...state };
  const transfers: RawTransfer[] = [];
  pages.forEach((pg, i) => {
    next[streams[i]!] = pg.nextCursor;
    transfers.push(...pg.transfers);
  });
  const more = Object.values(next).some((v) => v !== null) || p.streams().some((s) => !(s in next));
  return { transfers, nextCursor: more ? Buffer.from(JSON.stringify(next)).toString("base64url") : null };
}
