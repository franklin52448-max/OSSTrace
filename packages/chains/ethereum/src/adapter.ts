import type { Balance, ChainAdapter, TransactionsResult } from "@opentrace/core";
import { formatUnits } from "./units.ts";

const ETH_MAINNET_CHAIN_ID = 1;

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

interface EtherscanTx {
  hash: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  isError: string;
}

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

  async getRecentTransactions(address: string, limit: number): Promise<TransactionsResult> {
    if (!this.#etherscanApiKey) {
      return {
        available: false,
        reason: "ETHERSCAN_API_KEY not configured — transaction history needs a free key from etherscan.io/apis",
      };
    }
    const url = new URL("https://api.etherscan.io/v2/api");
    url.searchParams.set("chainid", String(ETH_MAINNET_CHAIN_ID));
    url.searchParams.set("module", "account");
    url.searchParams.set("action", "txlist");
    url.searchParams.set("address", address);
    url.searchParams.set("startblock", "0");
    url.searchParams.set("endblock", "99999999");
    url.searchParams.set("page", "1");
    url.searchParams.set("offset", String(limit));
    url.searchParams.set("sort", "desc");
    url.searchParams.set("apikey", this.#etherscanApiKey);

    const response = await fetch(url);
    if (!response.ok) {
      return { available: false, reason: `Etherscan API HTTP ${response.status}` };
    }
    const body = (await response.json()) as { status: string; message: string; result: EtherscanTx[] | string };
    if (body.status !== "1") {
      // Etherscan returns status "0" with message "No transactions found" for a real, empty history.
      if (body.message === "No transactions found") {
        return { available: true, transactions: [] };
      }
      return { available: false, reason: `Etherscan API: ${body.message}` };
    }
    const txs = body.result as EtherscanTx[];
    const lower = address.toLowerCase();
    return {
      available: true,
      transactions: txs.map((tx) => ({
        chain: "ethereum",
        hash: tx.hash,
        timestamp: new Date(Number(tx.timeStamp) * 1000).toISOString(),
        from: tx.from,
        to: tx.to || null,
        valueNative: formatUnits(BigInt(tx.value), 18),
        direction:
          tx.from.toLowerCase() === lower && tx.to.toLowerCase() === lower
            ? "self"
            : tx.from.toLowerCase() === lower
              ? "out"
              : "in",
      })),
    };
  }
}
