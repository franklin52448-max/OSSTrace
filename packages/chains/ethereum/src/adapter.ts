import type { Balance, ChainAdapter, TransactionsResult } from "@osstrace/core";
import { mergeHistory, type EtherscanTokenTx, type EtherscanTx } from "./etherscan.ts";
import { formatUnits } from "./units.ts";

const ETH_MAINNET_CHAIN_ID = 1;
const ETHERSCAN_V2_URL = "https://api.etherscan.io/v2/api";

export interface EthereumAdapterConfig {
  /** A standard Ethereum JSON-RPC endpoint. No API key required for balances. */
  rpcUrl: string;
  /**
   * Free key from etherscan.io/apis. Required only for transaction history — raw Ethereum
   * JSON-RPC has no "list transactions for an address" call; that needs an indexer, and
   * Etherscan's v2 API is the one we use for it. Balances work with no key at all.
   */
  etherscanApiKey?: string | undefined;
}

type EtherscanPage<Row> = { ok: true; rows: Row[] } | { ok: false; reason: string };

export class EthereumAdapter implements ChainAdapter {
  readonly chain = "ethereum" as const;
  readonly #rpcUrl: string;
  readonly #etherscanApiKey: string | undefined;

  constructor(config: EthereumAdapterConfig) {
    this.#rpcUrl = config.rpcUrl;
    this.#etherscanApiKey = config.etherscanApiKey;
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
      throw new Error(`eth_getBalance HTTP ${response.status} from ${this.#rpcUrl}`);
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
   */
  async getRecentTransactions(address: string, limit: number): Promise<TransactionsResult> {
    const apiKey = this.#etherscanApiKey;
    if (!apiKey) {
      return {
        available: false,
        reason: "ETHERSCAN_API_KEY not configured — transaction history needs a free key from etherscan.io/apis",
      };
    }
    const [native, tokens] = await Promise.all([
      this.#fetchAccountPage<EtherscanTx>("txlist", address, limit, apiKey),
      this.#fetchAccountPage<EtherscanTokenTx>("tokentx", address, limit, apiKey),
    ]);
    if (!native.ok) return { available: false, reason: native.reason };
    if (!tokens.ok) return { available: false, reason: tokens.reason };
    return { available: true, transactions: mergeHistory(native.rows, tokens.rows, address, limit) };
  }

  async #fetchAccountPage<Row>(
    action: "txlist" | "tokentx",
    address: string,
    limit: number,
    apiKey: string,
  ): Promise<EtherscanPage<Row>> {
    const url = new URL(ETHERSCAN_V2_URL);
    url.searchParams.set("chainid", String(ETH_MAINNET_CHAIN_ID));
    url.searchParams.set("module", "account");
    url.searchParams.set("action", action);
    url.searchParams.set("address", address);
    url.searchParams.set("startblock", "0");
    url.searchParams.set("endblock", "99999999");
    url.searchParams.set("page", "1");
    url.searchParams.set("offset", String(limit));
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
