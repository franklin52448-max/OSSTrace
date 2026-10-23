import { toChecksumAddress } from "@osstrace/contract";
import { ProviderError } from "../lib/errors.ts";
import { HttpClient, type Budget } from "../lib/http.ts";
import { isPositiveIntString } from "./amount.ts";
import { combinedFetch, type ChainProvider, type RawBalance, type RawTransfer, type StreamPage } from "./types.ts";
import { httpsUrl } from "./tokenLogos.ts";

// Blockscout v2 response shapes (only the fields the server reads). Recorded samples: tests/fixtures/blockscout/.
type BsAddr = { hash: string } | null;
type BsTx = {
  hash: string;
  block_number: number | null;
  timestamp: string | null;
  from: BsAddr;
  to: BsAddr;
  created_contract?: BsAddr;
  value: string;
  status: string | null;
};
type BsInternal = {
  transaction_hash: string;
  index: number;
  block_number: number;
  timestamp: string;
  from: BsAddr;
  to: BsAddr;
  created_contract?: BsAddr;
  value: string;
  success: boolean;
  error?: string | null;
  type?: string;
};
type BsToken = { address_hash: string; decimals: string | null; name: string | null; symbol: string | null; type: string; exchange_rate?: string | null; icon_url?: string | null };
type BsTokenTransfer = {
  transaction_hash: string;
  log_index: number;
  block_number: number;
  timestamp: string;
  from: BsAddr;
  to: BsAddr;
  token: BsToken;
  total: { decimals?: string | null; value?: string | null; token_id?: string | null } | null;
};
type BsPage<T> = { items: T[]; next_page_params: Record<string, string | number | null> | null };
type BsTokenBalance = { token: BsToken; token_id: string | null; value: string };
type BsAddress = { hash: string; coin_balance: string | null; is_contract?: boolean };

const ETH_COIN = "coingecko:ethereum";
const cs = (h: string | undefined | null) => (h ? toChecksumAddress(h) : null);
const sec = (iso: string | null) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);

function base(chainTx: { hash: string; blockNumber: number; time: number }) {
  return { chain: "ethereum" as const, txHash: chainTx.hash, blockNumber: chainTx.blockNumber, blockTime: chainTx.time, fromOwner: null, toOwner: null };
}

/** Native ETH value moved by a top-level transaction (successful, value > 0). */
export function normalizeEthTransactions(items: BsTx[]): RawTransfer[] {
  const out: RawTransfer[] = [];
  for (const t of items) {
    const time = sec(t.timestamp);
    if (t.block_number == null || time == null || t.status !== "ok" || !isPositiveIntString(t.value)) continue;
    const from = cs(t.from?.hash);
    const to = cs(t.to?.hash ?? t.created_contract?.hash);
    if (!from || !to) continue;
    out.push({
      ...base({ hash: t.hash, blockNumber: t.block_number, time }),
      id: `${t.hash}_t0`,
      from,
      to,
      tokenId: "native",
      tokenSymbol: "ETH",
      tokenName: "Ether",
      tokenDecimals: 18,
      tokenStandard: "native",
      amountRaw: t.value,
      priceCoin: ETH_COIN,
    });
  }
  return out;
}

/** Native ETH moved by internal calls (successful, value > 0). Id `<tx>_i<index>`. */
export function normalizeEthInternal(items: BsInternal[]): RawTransfer[] {
  const out: RawTransfer[] = [];
  for (const t of items) {
    const time = sec(t.timestamp);
    if (time == null || !t.success || t.error || !isPositiveIntString(t.value)) continue;
    const from = cs(t.from?.hash);
    const to = cs(t.to?.hash ?? t.created_contract?.hash);
    if (!from || !to) continue;
    out.push({
      ...base({ hash: t.transaction_hash, blockNumber: t.block_number, time }),
      id: `${t.transaction_hash}_i${t.index}`,
      from,
      to,
      tokenId: "native",
      tokenSymbol: "ETH",
      tokenName: "Ether",
      tokenDecimals: 18,
      tokenStandard: "native",
      amountRaw: t.value,
      priceCoin: ETH_COIN,
    });
  }
  return out;
}

/** ERC-20 / ERC-721 / ERC-1155 transfers. Id `<tx>_<logIndex>` (suffixed `_<n>` for batch duplicates). */
export function normalizeEthTokenTransfers(items: BsTokenTransfer[]): RawTransfer[] {
  const out: RawTransfer[] = [];
  const seen = new Map<string, number>();
  for (const t of items) {
    const time = sec(t.timestamp);
    const from = cs(t.from?.hash);
    const to = cs(t.to?.hash);
    if (time == null || !from || !to || !t.token?.address_hash || !t.total) continue;
    const type = t.token.type;
    let standard: RawTransfer["tokenStandard"];
    let amountRaw: string | null | undefined;
    let decimals: number | null;
    if (type === "ERC-20") {
      standard = "erc20";
      amountRaw = t.total.value;
      const d = t.total.decimals ?? t.token.decimals;
      decimals = d != null && /^\d+$/.test(d) ? Number(d) : null;
    } else if (type === "ERC-721") {
      standard = "erc721";
      amountRaw = "1";
      decimals = 0;
    } else if (type === "ERC-1155") {
      standard = "erc1155";
      amountRaw = t.total.value;
      decimals = 0;
    } else continue; // other token standards are not supported in v1
    if (!isPositiveIntString(amountRaw)) continue;
    const key = `${t.transaction_hash}_${t.log_index}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    const contract = toChecksumAddress(t.token.address_hash);
    out.push({
      ...base({ hash: t.transaction_hash, blockNumber: t.block_number, time }),
      id: n === 0 ? key : `${key}_${n}`,
      from,
      to,
      tokenId: contract,
      tokenSymbol: t.token.symbol ?? null,
      tokenName: standard === "erc20" ? t.token.name ?? null : [t.token.name, t.total.token_id ? `#${t.total.token_id}` : null].filter(Boolean).join(" ") || null,
      tokenDecimals: decimals,
      tokenStandard: standard,
      amountRaw,
      priceCoin: standard === "erc20" ? `ethereum:${contract}` : null,
    });
  }
  return out;
}

export function normalizeEthBalances(addr: BsAddress | null, tokens: BsTokenBalance[]): RawBalance[] {
  const out: RawBalance[] = [];
  if (addr?.coin_balance && /^\d+$/.test(addr.coin_balance)) {
    out.push({ tokenId: "native", symbol: "ETH", name: "Ether", decimals: 18, amountRaw: addr.coin_balance, priceCoin: ETH_COIN });
  }
  // Tokens Blockscout knows a market for come first: the balances route prices only the first ~150.
  const ranked = [...tokens].sort((a, b) => Number(!!b.token?.exchange_rate) - Number(!!a.token?.exchange_rate));
  for (const t of ranked) {
    if (t.token?.type !== "ERC-20" || !isPositiveIntString(t.value)) continue;
    const contract = toChecksumAddress(t.token.address_hash);
    const d = t.token.decimals;
    out.push({
      tokenId: contract,
      symbol: t.token.symbol ?? null,
      name: t.token.name ?? null,
      decimals: d != null && /^\d+$/.test(d) ? Number(d) : null,
      amountRaw: t.value,
      priceCoin: `ethereum:${contract}`,
      logoUrl: httpsUrl(t.token.icon_url),
    });
  }
  return out;
}

const pageTimes = (items: { timestamp: string | null }[]) => {
  const ts = items.map((i) => sec(i.timestamp)).filter((x): x is number => x != null);
  return { oldestTime: ts.length ? Math.min(...ts) : null, newestTime: ts.length ? Math.max(...ts) : null };
};

export class BlockscoutProvider implements ChainProvider {
  readonly chain = "ethereum" as const;
  readonly id = "blockscout";
  readonly name: string = "Blockscout (eth.blockscout.com)";
  readonly http: HttpClient;
  private readonly baseUrl: string;
  constructor(baseUrl: string, fetchImpl?: typeof fetch) {
    this.baseUrl = baseUrl;
    this.http = new HttpClient(this.id, 4, fetchImpl);
    try {
      this.name = `Blockscout (${new URL(baseUrl).host})`;
    } catch {
      /* keep default */
    }
  }

  streams() {
    return ["transactions", "token-transfers", "internal-transactions"];
  }

  private url(path: string, cursor: string | null) {
    const u = new URL(`${this.baseUrl}/api/v2${path}`);
    if (cursor) {
      const params = JSON.parse(cursor) as Record<string, string | number | null>;
      for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async fetchStreamPage(address: string, stream: string, cursor: string | null, budget: Budget): Promise<StreamPage> {
    const a = toChecksumAddress(address);
    // The per-address internal-transactions endpoint is slow for busy addresses (observed > 100 s on 2026-10-22).
    const timeoutMs = stream === "internal-transactions" ? 8_000 : 20_000;
    const { data } = await this.http.json<BsPage<BsTx & BsInternal & BsTokenTransfer>>(this.url(`/addresses/${a}/${stream}`, cursor), { budget, timeoutMs });
    if (!data || !Array.isArray(data.items)) throw new ProviderError(this.id, "Blockscout returned an unexpected response");
    const transfers =
      stream === "transactions"
        ? normalizeEthTransactions(data.items)
        : stream === "internal-transactions"
          ? normalizeEthInternal(data.items)
          : normalizeEthTokenTransfers(data.items);
    return {
      transfers,
      nextCursor: data.next_page_params ? JSON.stringify(data.next_page_params) : null,
      ...pageTimes(data.items),
    };
  }

  fetchTransfers(address: string, opts: { before?: string | null; budget: Budget }) {
    return combinedFetch(this, address, opts.before, opts.budget);
  }

  async fetchBalances(address: string, budget: Budget): Promise<RawBalance[]> {
    const a = toChecksumAddress(address);
    const [addr, tokens] = await Promise.all([
      this.http.json<BsAddress>(`${this.baseUrl}/api/v2/addresses/${a}`, { budget }).catch((e) => {
        // Blockscout answers 404 for addresses it has never seen: that is a real zero balance.
        if (e instanceof ProviderError && /HTTP 404/.test(e.message)) return { data: null };
        throw e;
      }),
      this.http.json<BsTokenBalance[]>(`${this.baseUrl}/api/v2/addresses/${a}/token-balances`, { budget }).catch((e) => {
        if (e instanceof ProviderError && /HTTP 404/.test(e.message)) return { data: [] as BsTokenBalance[] };
        throw e;
      }),
    ]);
    return normalizeEthBalances(addr.data, Array.isArray(tokens.data) ? tokens.data : []);
  }

  async ping() {
    try {
      await this.http.json(`${this.baseUrl}/api/v2/stats`, { timeoutMs: 8000, maxRetries: 0 });
      return { ok: true };
    } catch (e) {
      return { ok: false, note: e instanceof Error ? e.message : "unreachable" };
    }
  }
}
