import { ProviderError } from "../lib/errors.ts";
import { HttpClient, type Budget } from "../lib/http.ts";
import type { RawTransfer, StreamPage } from "./types.ts";

// Solscan Pro API v2.0's account/transfer endpoint: one indexed, paginated call returns many
// transfers already joined to their token metadata -- no per-transaction round trip the way
// SolanaRpcProvider's getSignaturesForAddress + N*getTransaction does. That N+1 pattern is this
// project's own documented reason deep history is expensive on raw RPC (see SCALING-AND-COSTS.md,
// local-only); Solscan is the paid fast path for exactly that case, used only when the caller has
// set Budget.preferIndexed (signed-in users, see syncAll's `anon` flag) so the Lite-tier rate/
// request budget is spent on the users it was bought to serve, not every anonymous lookup.
//
// Solscan represents native SOL as its own synthetic "token": token_address
// "So11111111111111111111111111111111111111111" (NOT the real wrapped-SOL mint, which ends ...112),
// decimals 9, activity_type still ACTIVITY_SPL_TRANSFER -- confirmed against a real wallet's real
// history. Mapped to tokenId "native" here so downstream code can't tell which source a transfer
// came from (same contract SolanaRpcProvider's own RPC path already promises).
const SOLSCAN_NATIVE_SOL_PLACEHOLDER = "So11111111111111111111111111111111111111111";
const SOL_COIN = "coingecko:solana";

type SolscanTransfer = {
  trans_id: string;
  block_id: number;
  block_time: number;
  activity_type: string;
  from_address: string;
  to_address: string;
  token_address: string;
  token_decimals: number;
  amount: number | string;
  flow: "in" | "out";
};

type SolscanTransferResponse = {
  success: boolean;
  data?: SolscanTransfer[];
  errors?: { message?: string } | string;
};

/** One Solscan transfer record -> this project's own RawTransfer shape. Ordinal disambiguates
 * same-signature rows (Solscan returns one row per transfer, not per transaction, so a tx moving
 * two tokens already appears as two rows -- id still needs a counter to stay unique per tx). */
export function normalizeSolscanTransfer(t: SolscanTransfer, ordinal: number): RawTransfer | null {
  if (!t.trans_id || !t.from_address || !t.to_address || t.block_time == null) return null;
  const amountRaw = typeof t.amount === "number" ? Math.trunc(t.amount).toString() : t.amount;
  if (!/^\d+$/.test(amountRaw)) return null;
  const native = t.token_address === SOLSCAN_NATIVE_SOL_PLACEHOLDER;
  return {
    chain: "solana",
    id: `${t.trans_id}_${ordinal}`,
    txHash: t.trans_id,
    blockNumber: t.block_id,
    blockTime: t.block_time,
    from: t.from_address,
    to: t.to_address,
    fromOwner: null,
    toOwner: null,
    tokenId: native ? "native" : t.token_address,
    tokenSymbol: native ? "SOL" : null,
    tokenName: native ? "Solana" : null,
    tokenDecimals: t.token_decimals,
    tokenStandard: native ? "native" : "spl",
    amountRaw,
    priceCoin: native ? SOL_COIN : `solana:${t.token_address}`,
  };
}

const PAGE_SIZE = 100;

/** Transfers directly between `address` and one specific `counterparty` -- NOT a page of address's
 * general history. A busy wallet's chronological history can run thousands of rows deep before it
 * happens to reach a specific counterparty's transfers (confirmed on a real 347-token-account
 * wallet: 500+ unrelated rows before any transfer with a known counterparty appeared), so the
 * general sync-then-filter path genuinely never reaches them within any reasonable budget. Solscan
 * supports filtering server-side by `from`/`to` directly -- two targeted calls here (one per
 * direction) replace what would otherwise need unbounded general pagination. Used only for a
 * small, explicit counterparty list (Find Connections, narrowing by one counterparty in the
 * Transfers panel), never for a general per-address sync. */
export async function fetchSolscanTransfersBetween(http: HttpClient, apiKey: string, address: string, counterparty: string, budget: Budget): Promise<RawTransfer[]> {
  const fetchDirection = async (param: "from" | "to"): Promise<SolscanTransfer[]> => {
    const url = `https://pro-api.solscan.io/v2.0/account/transfer?address=${encodeURIComponent(address)}&${param}=${encodeURIComponent(counterparty)}&page=1&page_size=${PAGE_SIZE}&sort_by=block_time&sort_order=desc`;
    const { data } = await http.json<SolscanTransferResponse>(url, { headers: { token: apiKey }, budget, cooldownKey: "solscan" });
    if (!data.success) {
      const msg = typeof data.errors === "string" ? data.errors : data.errors?.message;
      throw new ProviderError("solscan", msg ? `Solscan: ${msg}` : "Solscan request failed");
    }
    return data.data ?? [];
  };
  const [fromRows, toRows] = await Promise.all([fetchDirection("from"), fetchDirection("to")]);
  // Keyed without `flow`: the same transfer can come back from both the from= and to= queries
  // (e.g. a direct transfer matches "from=counterparty" once and "to=counterparty" not at all,
  // but a swap/multi-leg transaction can touch the pair in both directions) -- `flow` is relative
  // to which side of the pair asked, so it's not part of the row's real identity here.
  const byId = new Map<string, SolscanTransfer>();
  for (const r of [...fromRows, ...toRows]) byId.set(`${r.trans_id}:${r.token_address}:${r.amount}:${r.from_address}:${r.to_address}`, r);
  const transfers: RawTransfer[] = [];
  [...byId.values()].forEach((r, i) => {
    const t = normalizeSolscanTransfer(r, i);
    if (t) transfers.push(t);
  });
  return transfers;
}

/** One page of an address's transfer history from Solscan's indexer, newest-first. Cursor is the
 * next page number as a string (Solscan pages are 1-indexed); null once a short page confirms
 * there's nothing older left. */
export async function fetchSolscanPage(http: HttpClient, apiKey: string, address: string, cursor: string | null, budget: Budget): Promise<StreamPage> {
  const page = cursor ? Number(cursor) : 1;
  const url = `https://pro-api.solscan.io/v2.0/account/transfer?address=${encodeURIComponent(address)}&page=${page}&page_size=${PAGE_SIZE}&sort_by=block_time&sort_order=desc`;
  const { data } = await http.json<SolscanTransferResponse>(url, { headers: { token: apiKey }, budget, cooldownKey: "solscan" });
  if (!data.success) {
    const msg = typeof data.errors === "string" ? data.errors : data.errors?.message;
    throw new ProviderError("solscan", msg ? `Solscan: ${msg}` : "Solscan request failed");
  }
  const rows = data.data ?? [];
  const transfers: RawTransfer[] = [];
  rows.forEach((r, i) => {
    const t = normalizeSolscanTransfer(r, i);
    if (t) transfers.push(t);
  });
  const times = rows.map((r) => r.block_time).filter((t): t is number => typeof t === "number");
  const exhausted = rows.length < PAGE_SIZE;
  return {
    transfers,
    nextCursor: exhausted ? null : String(page + 1),
    oldestTime: times.length ? Math.min(...times) : null,
    newestTime: times.length ? Math.max(...times) : null,
  };
}
