import type { Balance, ChainAdapter, TransactionsPageOptions, TransactionsResult } from "@osstrace/core";
import {
  decodeCursor,
  encodeCursor,
  mergeHistoryPage,
  requestedRows,
  type EthereumCursor,
  type EtherscanTokenTx,
  type EtherscanTx,
} from "./etherscan.ts";
import { formatUnits } from "./units.ts";

const ETH_MAINNET_CHAIN_ID = 1;
const ETHERSCAN_V2_URL = "https://api.etherscan.io/v2/api";
/** Etherscan's own ceiling on how far back one account query reaches: `page × offset` ≤ 10000. */
const ETHERSCAN_MAX_WINDOW = 10_000;
/** The `endblock` Etherscan's docs use for "up to the latest block". */
const LATEST_END_BLOCK = 99_999_999;

export interface EthereumAdapterConfig {
  /** A standard Ethereum JSON-RPC endpoint. No API key required for balances. */
  rpcUrl: string;
  /**
   * Free key from etherscan.io/apis. Required only for transaction history — raw Ethereum
   * JSON-RPC has no "list transactions for an address" call; that needs an indexer, and
   * Etherscan's v2 API is the one we use for it. Balances work with no key at all.
   */
  etherscanApiKey?: string | undefined;
  /**
   * The Etherscan v2 API base URL. Defaults to the real one (`https://api.etherscan.io/v2/api`);
   * only override it to point at another endpoint that speaks the same `txlist`/`tokentx` API.
   */
  etherscanUrl?: string | undefined;
}

type EtherscanPage<Row> = { ok: true; rows: Row[] } | { ok: false; reason: string };

export class EthereumAdapter implements ChainAdapter {
  readonly chain = "ethereum" as const;
  readonly #rpcUrl: string;
  readonly #etherscanApiKey: string | undefined;
  readonly #etherscanUrl: string;

  constructor(config: EthereumAdapterConfig) {
    this.#rpcUrl = config.rpcUrl;
    this.#etherscanApiKey = config.etherscanApiKey;
    this.#etherscanUrl = config.etherscanUrl ?? ETHERSCAN_V2_URL;
  }

  async getBalance(address: string): Promise<Balance> {
    const response = await fetch(this.#rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBalance",
        params: [address, "latest"],
      }),
    });
    if (!response.ok) {
      // Never put the RPC URL in the message: hosted RPC providers embed the API key in it
      // (`.../v2/<key>`, `?api-key=<key>`), and the Explorer returns this message to the client.
      throw new Error(`eth_getBalance HTTP ${response.status} from the configured Ethereum RPC`);
    }
    const body = (await response.json()) as { result?: string; error?: { message: string } };
    if (body.error) {
      throw new Error(`eth_getBalance RPC error: ${body.error.message}`);
    }
    const weiHex = body.result;
    if (weiHex === undefined) {
      throw new Error("eth_getBalance returned no result");
    }
    const wei = BigInt(weiHex);
    return {
      chain: "ethereum",
      address,
      native: { symbol: "ETH", amount: formatUnits(wei, 18), decimals: 18 },
      asOf: new Date().toISOString(),
    };
  }

  /**
   * Native ETH transactions (`txlist`) and ERC-20 transfers (`tokentx`), fetched in parallel —
   * two Etherscan calls per lookup — and merged one-entry-per-hash by `mergeHistory` (see
   * `etherscan.ts` and this package's README for the exact merge rules). If either call fails,
   * the whole result is `available: false`: returning native history with the token side
   * silently missing would look complete when it isn't.
   *
   * Paging (ADR 0018) uses Etherscan's own block range: the page after a cursor is fetched with
   * `endblock` = the cursor's block, and the rows of that block already shown are filtered out
   * (see `EthereumCursor` in `etherscan.ts`). Not `page=2`: the two lists are merged and trimmed
   * to `limit`, so "page 2 of txlist" and "page 2 of tokentx" don't line up with each other or
   * with what the caller was actually shown, and would skip or repeat entries.
   */
  async getRecentTransactions(address: string, limit: number, options: TransactionsPageOptions = {}): Promise<TransactionsResult> {
    const apiKey = this.#etherscanApiKey;
    if (!apiKey) {
      return {
        available: false,
        reason: "ETHERSCAN_API_KEY not configured — transaction history needs a free key from etherscan.io/apis",
      };
    }
    let before: EthereumCursor | undefined;
    if (options.before !== undefined) {
      const decoded = decodeCursor(options.before);
      if (!decoded) {
        return { available: false, reason: "invalid `before` cursor for ethereum — pass the nextCursor from a previous page unchanged" };
      }
      before = decoded;
    }
    const requested = requestedRows(limit, before);
    if (Math.max(requested.native, requested.token) > ETHERSCAN_MAX_WINDOW) {
      return {
        available: false,
        reason: `can't page further: this block holds more of this address's transactions than Etherscan returns in one query (${ETHERSCAN_MAX_WINDOW})`,
      };
    }
    const endBlock = before?.block ?? LATEST_END_BLOCK;
    const [native, tokens] = await Promise.all([
      this.#fetchAccountPage<EtherscanTx>("txlist", address, requested.native, endBlock, apiKey),
      this.#fetchAccountPage<EtherscanTokenTx>("tokentx", address, requested.token, endBlock, apiKey),
    ]);
    if (!native.ok) return { available: false, reason: native.reason };
    if (!tokens.ok) return { available: false, reason: tokens.reason };
    const page = mergeHistoryPage(native.rows, tokens.rows, address, limit, before);
    return {
      available: true,
      transactions: page.transactions,
      ...(page.nextCursor ? { nextCursor: encodeCursor(page.nextCursor) } : {}),
    };
  }

  async #fetchAccountPage<Row>(
    action: "txlist" | "tokentx",
    address: string,
    offset: number,
    endBlock: number,
    apiKey: string,
  ): Promise<EtherscanPage<Row>> {
    const url = new URL(this.#etherscanUrl);
    url.searchParams.set("chainid", String(ETH_MAINNET_CHAIN_ID));
    url.searchParams.set("module", "account");
    url.searchParams.set("action", action);
    url.searchParams.set("address", address);
    url.searchParams.set("startblock", "0");
    url.searchParams.set("endblock", String(endBlock));
    url.searchParams.set("page", "1");
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("sort", "desc");
    url.searchParams.set("apikey", apiKey);

    let response: Response;
    try {
      response = await fetch(url);
    } catch (cause) {
      return { ok: false, reason: `Etherscan ${action}: ${cause instanceof Error ? cause.message : String(cause)}` };
    }
    if (!response.ok) {
      return { ok: false, reason: `Etherscan ${action}: HTTP ${response.status}` };
    }
    const body = (await response.json()) as { status: string; message: string; result: Row[] | string };
    if (body.status !== "1") {
      // Etherscan returns status "0" with message "No transactions found" for a real, empty history.
      if (body.message === "No transactions found") {
        return { ok: true, rows: [] };
      }
      // On a real error Etherscan puts the cause in `result` (e.g. "Missing/Invalid API Key"),
      // with only a generic "NOTOK" in `message` — surface the useful one.
      const detail = typeof body.result === "string" && body.result ? body.result : body.message;
      return { ok: false, reason: `Etherscan ${action}: ${detail}` };
    }
    if (!Array.isArray(body.result)) {
      return { ok: false, reason: `Etherscan ${action}: unexpected response shape` };
    }
    return { ok: true, rows: body.result };
  }
}
