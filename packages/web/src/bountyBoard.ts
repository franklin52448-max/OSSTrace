// The bounty board's pure logic: per-asset funding totals, and the list's filter/sort. No React, no
// network, no chain SDK -- BountiesView renders what these return, and the board's tests exercise
// them directly as well as through the real UI.
//
// Two honesty rules from ADR 0009/0020 shape everything here:
//  - `reward` is the opener's own free text. It is never parsed, summed or sorted as a number.
//  - Verified deposits are summed per asset, never converted between assets or to a dollar figure.
//    So "most funded" can only ever mean "most funded in one chosen asset".
import { CHAIN_NAMES, NATIVE_SYMBOLS, type Bounty, type BountyAsset, type BountyDeposit, type BountyStatus, type DepositChain } from "@osstrace/contract";
import { compareDecimalAmounts, sumDecimalAmounts } from "./decimalAmount.ts";

export const DEPOSIT_NATIVE_SYMBOL: Record<DepositChain, string> = { ...NATIVE_SYMBOLS, bitcoin: "BTC" };
export const DEPOSIT_CHAIN_NAME: Record<DepositChain, string> = { ...CHAIN_NAMES, bitcoin: "Bitcoin" };

/**
 * Display symbols for the stablecoins the server accepts by default (server chain/deposits.ts
 * DEFAULT_ALLOWED_TOKENS_*). These are real, public contract/mint addresses, used only to print
 * "USDC" instead of a shortened address. Any other contract (an operator-configured extra token)
 * still shows as its shortened address -- never a guessed name.
 */
const KNOWN_TOKEN_SYMBOLS: Record<string, string> = {
  "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC",
  "ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT",
  "bnb:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": "USDC",
  "bnb:0x55d398326f99059ff775485246999027b3197955": "USDT",
  "solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
  "solana:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": "USDT",
};

function shortContract(value: string): string {
  return value.length > 11 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

/** One asset's identity: EVM contracts are case-insensitive hex, so they're compared lowercased;
 *  Solana mints are case-sensitive base58 and kept as-is. */
export function assetKey(chain: DepositChain, asset: BountyAsset): string {
  if (asset === "native") return `${chain}:native`;
  return `${chain}:${chain === "solana" ? asset.contract : asset.contract.toLowerCase()}`;
}

/** A chain whose native symbol an earlier chain already uses (Robinhood Chain's ETH after Ethereum's). */
function sharesNativeSymbol(chain: DepositChain): boolean {
  const chains = Object.keys(DEPOSIT_NATIVE_SYMBOL) as DepositChain[];
  return chains.slice(0, chains.indexOf(chain)).some((c) => DEPOSIT_NATIVE_SYMBOL[c] === DEPOSIT_NATIVE_SYMBOL[chain]);
}

/** Totals chips sit side by side, so "1 ETH" next to "1 ETH" would read as one asset: a native unit
 *  that repeats an earlier chain's symbol says which one, e.g. "ETH (Robinhood Chain)". */
export function assetLabel(chain: DepositChain, asset: BountyAsset): string {
  if (asset === "native") return sharesNativeSymbol(chain) ? `${DEPOSIT_NATIVE_SYMBOL[chain]} (${DEPOSIT_CHAIN_NAME[chain]})` : DEPOSIT_NATIVE_SYMBOL[chain];
  return KNOWN_TOKEN_SYMBOLS[assetKey(chain, asset)] ?? shortContract(asset.contract);
}

/** e.g. "USDC on Ethereum" -- disambiguates the same symbol on two chains. */
export function assetDescription(chain: DepositChain, asset: BountyAsset): string {
  const symbol = asset === "native" ? DEPOSIT_NATIVE_SYMBOL[chain] : assetLabel(chain, asset);
  return `${symbol} on ${DEPOSIT_CHAIN_NAME[chain]}`;
}

export type FundingTotal = { key: string; chain: DepositChain; asset: BountyAsset; total: string; count: number };

/** Verified deposits summed per asset, in first-seen order (deposits arrive oldest first). */
export function fundingTotals(deposits: readonly BountyDeposit[]): FundingTotal[] {
  const groups = new Map<string, { chain: DepositChain; asset: BountyAsset; amounts: string[] }>();
  for (const d of deposits) {
    const key = assetKey(d.chain, d.asset);
    const entry = groups.get(key) ?? { chain: d.chain, asset: d.asset, amounts: [] };
    entry.amounts.push(d.amount);
    groups.set(key, entry);
  }
  return [...groups].map(([key, g]) => ({ key, chain: g.chain, asset: g.asset, total: sumDecimalAmounts(g.amounts), count: g.amounts.length }));
}

/** Every asset any bounty on the board has a verified deposit in -- what "most funded in …" can sort by. */
export function boardAssets(bounties: readonly Bounty[]): { key: string; chain: DepositChain; asset: BountyAsset }[] {
  const seen = new Map<string, { key: string; chain: DepositChain; asset: BountyAsset }>();
  for (const b of bounties) for (const d of b.deposits) {
    const key = assetKey(d.chain, d.asset);
    if (!seen.has(key)) seen.set(key, { key, chain: d.chain, asset: d.asset });
  }
  return [...seen.values()];
}

export type StatusFilter = BountyStatus | "all";
export const STATUS_FILTERS: readonly StatusFilter[] = ["open", "claimed", "cancelled", "all"];

/** "newest" / "oldest" by when it was opened, or `funded:<assetKey>` -- most funded in that one asset first. */
export type BountySort = "newest" | "oldest" | `funded:${string}`;

export type BoardQuery = { status: StatusFilter; sort: BountySort };
export const DEFAULT_QUERY: BoardQuery = { status: "open", sort: "newest" };

export function statusCounts(bounties: readonly Bounty[]): Record<StatusFilter, number> {
  const counts: Record<StatusFilter, number> = { open: 0, claimed: 0, cancelled: 0, all: bounties.length };
  for (const b of bounties) counts[b.status] += 1;
  return counts;
}

const byNewest = (a: Bounty, b: Bounty): number => (a.openedAt < b.openedAt ? 1 : a.openedAt > b.openedAt ? -1 : 0);

function fundedIn(b: Bounty, key: string): string | null {
  const amounts = b.deposits.filter((d) => assetKey(d.chain, d.asset) === key).map((d) => d.amount);
  return amounts.length ? sumDecimalAmounts(amounts) : null;
}

export function sortBounties(bounties: readonly Bounty[], sort: BountySort): Bounty[] {
  const list = [...bounties];
  if (sort === "newest") return list.sort(byNewest);
  if (sort === "oldest") return list.sort((a, b) => byNewest(b, a));
  const key = sort.slice("funded:".length);
  const totals = new Map(list.map((b) => [b.id, fundedIn(b, key)]));
  return list.sort((a, b) => {
    const x = totals.get(a.id) ?? null;
    const y = totals.get(b.id) ?? null;
    // Bounties with no deposit in this asset go after every bounty that has one (newest first among
    // themselves) -- "unfunded in USDC" isn't the same as "funded with 0 USDC", but both sort last.
    if (x === null || y === null) return x === y ? byNewest(a, b) : x === null ? 1 : -1;
    return compareDecimalAmounts(y, x) || byNewest(a, b);
  });
}

export function applyQuery(bounties: readonly Bounty[], query: BoardQuery): Bounty[] {
  const filtered = bounties.filter((b) => query.status === "all" || b.status === query.status);
  return sortBounties(filtered, query.sort);
}
