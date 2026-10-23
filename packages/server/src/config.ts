import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { DEFAULT_ALLOWED_TOKENS_BASE, DEFAULT_ALLOWED_TOKENS_BNB, DEFAULT_ALLOWED_TOKENS_ETHEREUM, DEFAULT_ALLOWED_TOKENS_ROBINHOOD, DEFAULT_ALLOWED_TOKENS_SOLANA } from "./chain/deposits.ts";

export type Config = {
  port: number;
  host: string;
  dbPath: string;
  allowSignup: boolean;
  alertPollSec: number;
  allowedOrigins: string[];
  cookieSecure: boolean;
  production: boolean;
  trustProxy: boolean;
  /** Never logged. */
  solanaRpcUrl: string;
  /** True when the operator supplied their own RPC (URL or file). */
  solanaRpcCustom: boolean;
  /** Never logged. Null unless the operator configures one -- unlike Solana, there's no reliable
   *  free public Ethereum mainnet RPC to default to, so Ethereum falls back to ethBlockscoutUrl
   *  (which needs no key) when this is unset, the same shape as solanaRpcUrl's custom/default split. */
  ethRpcUrl: string | null;
  /** Never logged. Optional -- used only for a signed-in caller's deep Solana history (ADR: anon
   *  mode's Budget.preferIndexed); unset means that path just stays on the free RPC merge-cursor. */
  solscanApiKey: string | null;
  ethBlockscoutUrl: string;
  /** Never logged. BNB Smart Chain JSON-RPC: bounty-deposit verification over plain `eth_*` calls, and
   *  -- when it's an Alchemy URL -- address history and balances through Alchemy's enhanced API
   *  (chain/alchemy.ts; Etherscan's free tier refuses chain 56, so there's no free keyless BSC indexer
   *  to read instead). The zero-config default is BNB Chain's own public RPC: deposits work on it,
   *  address lookups report that an Alchemy URL is needed, never an empty wallet. */
  bnbRpcUrl: string;
  /** Robinhood Chain's own official Blockscout instance (robinhoodchain.blockscout.com) -- the same
   *  zero-key `/api/v2` shape as ethBlockscoutUrl, one instance per chain. Deliberately the per-chain
   *  instance, not Blockscout's keyed multichain aggregator (api.blockscout.com). */
  robinhoodBlockscoutUrl: string;
  /** Never logged. Robinhood Chain JSON-RPC, used for bounty-deposit verification. The chain runs its
   *  own public RPC (rate-limited, no key), so this has the same zero-config-with-override shape as
   *  bnbRpcUrl rather than ethRpcUrl's null default. */
  robinhoodRpcUrl: string;
  /** Base's history/balance source: a Blockscout v2 API, the same shape `ethBlockscoutUrl` serves,
   *  read by the same BlockscoutProvider. Defaults to Blockscout's hosted PRO API for chain 8453,
   *  because Base's own per-instance explorer (base.blockscout.com) answers every non-browser API
   *  call with a Cloudflare bot challenge (HTTP 403, checked 2026-10-23), and Etherscan's V2 API --
   *  BaseScan -- refuses Base on its free tier ("Paid Plan required" in its own /v2/chainlist). The
   *  PRO API's free tier needs only a free key (`blockscoutApiKey`); BASE_BLOCKSCOUT_URL can point
   *  this at any other Blockscout instance instead (e.g. a self-hosted one, which needs no key). */
  baseBlockscoutUrl: string;
  /** Never logged. Blockscout PRO API key (free tier, no card needed). Only ever sent to
   *  api.blockscout.com; without it a PRO-API-backed chain reports the key as missing, never empty. */
  blockscoutApiKey: string | null;
  /** Never logged. Base JSON-RPC, used for bounty-deposit verification. Unlike Ethereum, Base runs
   *  an official public endpoint (rate-limited, "not for production" per Base's own docs -- fine for
   *  occasional deposit checks), so this defaults to it with the same override shape as solanaRpcUrl. */
  baseRpcUrl: string;
  /** Bitcoin bounty-deposit verification source (an Esplora-API block explorer, no key needed) --
   *  Blockstream.info by default; mempool.space speaks the same API and can be swapped in via
   *  ESPLORA_URL. Bitcoin is deposit-only here: nothing else in this server reads Bitcoin. */
  esploraUrl: string;
  defillamaUrl: string;
  jupiterTokensUrl: string;
  /** Public wallet addresses bounty depositors pay into -- never a key this server holds (ADR 0020). */
  depositWallets: { ethereum?: string; solana?: string; bnb?: string; robinhood?: string; bitcoin?: string; base?: string };
  /** Assets a bounty deposit may be verified in, beyond each chain's own native currency (always
   *  allowed) -- defaults to real USDC/USDT (Base: USDC only), extendable per-deployment via
   *  DEPOSIT_ALLOWED_TOKENS_ETHEREUM/_SOLANA/_BNB/_ROBINHOOD/_BASE (comma-separated, added to the
   *  defaults, never replacing them). Without this, any worthless token a depositor mints themselves
   *  would verify as a real "deposit" (see chain/deposits.ts). */
  depositAllowedTokens: { ethereum: Set<string>; solana: Set<string>; bnb: Set<string>; robinhood: Set<string>; base: Set<string> };
  /** Enables POST /api/_test/alerts/tick (off unless SERVER_TEST_HOOKS=1). */
  testHooks: boolean;
  /** Local-dev-only: every request is treated as signed in as a fixed fake user, no cookie needed.
   *  Always false when `production` is true, no matter what DEV_SKIP_AUTH is set to -- see loadConfig. */
  devSkipAuth: boolean;
  logLevel: string;
};

export const DEFAULT_SOLANA_RPC = "https://api.mainnet-beta.solana.com";
/** BNB Chain's own public dataseed endpoint (no key). */
export const DEFAULT_BNB_RPC = "https://bsc-dataseed.bnbchain.org";
/** Robinhood Chain's own public mainnet RPC (chain id 4663, no key, rate-limited). */
export const DEFAULT_ROBINHOOD_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const DEFAULT_ROBINHOOD_BLOCKSCOUT = "https://robinhoodchain.blockscout.com";
/** Base's own official public RPC (chain id 8453, no key). */
export const DEFAULT_BASE_RPC = "https://mainnet.base.org";
/** Blockscout's hosted multichain API, Base mainnet's chain id in the path. */
export const DEFAULT_BASE_BLOCKSCOUT_URL = "https://api.blockscout.com/8453";

const bool = (v: string | undefined, dflt: boolean) => {
  if (v === undefined || v === "") return dflt;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
};

const expandHome = (p: string) => (p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";
  const port = Number(env.PORT ?? 5320);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("PORT must be a valid port number");

  let solanaRpcUrl = DEFAULT_SOLANA_RPC;
  let solanaRpcCustom = false;
  if (env.SOLANA_RPC_URL_FILE) {
    // The file holds only the URL (which may embed an API key). Its contents are never logged.
    const raw = readFileSync(expandHome(env.SOLANA_RPC_URL_FILE), "utf8").trim();
    if (!/^https?:\/\//.test(raw)) throw new Error("SOLANA_RPC_URL_FILE does not contain an http(s) URL");
    solanaRpcUrl = raw;
    solanaRpcCustom = true;
  } else if (env.SOLANA_RPC_URL) {
    solanaRpcUrl = env.SOLANA_RPC_URL.trim();
    solanaRpcCustom = true;
  }

  let ethRpcUrl: string | null = null;
  if (env.ETH_RPC_URL_FILE) {
    const raw = readFileSync(expandHome(env.ETH_RPC_URL_FILE), "utf8").trim();
    if (!/^https?:\/\//.test(raw)) throw new Error("ETH_RPC_URL_FILE does not contain an http(s) URL");
    ethRpcUrl = raw;
  } else if (env.ETH_RPC_URL) {
    ethRpcUrl = env.ETH_RPC_URL.trim();
  }

  let bnbRpcUrl = DEFAULT_BNB_RPC;
  if (env.BNB_RPC_URL_FILE) {
    const raw = readFileSync(expandHome(env.BNB_RPC_URL_FILE), "utf8").trim();
    if (!/^https?:\/\//.test(raw)) throw new Error("BNB_RPC_URL_FILE does not contain an http(s) URL");
    bnbRpcUrl = raw;
  } else if (env.BNB_RPC_URL) {
    bnbRpcUrl = env.BNB_RPC_URL.trim();
  }

  let robinhoodRpcUrl = DEFAULT_ROBINHOOD_RPC;
  if (env.ROBINHOOD_RPC_URL_FILE) {
    const raw = readFileSync(expandHome(env.ROBINHOOD_RPC_URL_FILE), "utf8").trim();
    if (!/^https?:\/\//.test(raw)) throw new Error("ROBINHOOD_RPC_URL_FILE does not contain an http(s) URL");
    robinhoodRpcUrl = raw;
  } else if (env.ROBINHOOD_RPC_URL) {
    robinhoodRpcUrl = env.ROBINHOOD_RPC_URL.trim();
  }

  let baseRpcUrl = DEFAULT_BASE_RPC;
  if (env.BASE_RPC_URL_FILE) {
    const raw = readFileSync(expandHome(env.BASE_RPC_URL_FILE), "utf8").trim();
    if (!/^https?:\/\//.test(raw)) throw new Error("BASE_RPC_URL_FILE does not contain an http(s) URL");
    baseRpcUrl = raw;
  } else if (env.BASE_RPC_URL) {
    baseRpcUrl = env.BASE_RPC_URL.trim();
  }

  const solscanApiKey = env.SOLSCAN_API_KEY?.trim() || null;
  const blockscoutApiKey = env.BLOCKSCOUT_API_KEY?.trim() || null;

  const origins = (env.ALLOWED_ORIGINS ?? "http://127.0.0.1:5301,http://localhost:5301")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);

  const pollSec = Number(env.ALERT_POLL_SEC ?? 60);

  return {
    port,
    host: env.HOST ?? "127.0.0.1",
    dbPath: expandHome(env.SERVER_DB ?? "./data/server.db"),
    allowSignup: bool(env.ALLOW_SIGNUP, true),
    alertPollSec: Number.isFinite(pollSec) && pollSec >= 5 ? pollSec : 60,
    allowedOrigins: origins,
    cookieSecure: bool(env.COOKIE_SECURE, production),
    production,
    trustProxy: bool(env.TRUST_PROXY, false),
    solanaRpcUrl,
    solanaRpcCustom,
    ethRpcUrl,
    solscanApiKey,
    ethBlockscoutUrl: (env.ETH_BLOCKSCOUT_URL ?? "https://eth.blockscout.com").replace(/\/$/, ""),
    bnbRpcUrl,
    robinhoodBlockscoutUrl: (env.ROBINHOOD_BLOCKSCOUT_URL ?? DEFAULT_ROBINHOOD_BLOCKSCOUT).replace(/\/$/, ""),
    robinhoodRpcUrl,
    baseBlockscoutUrl: (env.BASE_BLOCKSCOUT_URL ?? DEFAULT_BASE_BLOCKSCOUT_URL).replace(/\/$/, ""),
    blockscoutApiKey,
    baseRpcUrl,
    esploraUrl: (env.ESPLORA_URL ?? "https://blockstream.info").replace(/\/$/, ""),
    defillamaUrl: (env.DEFILLAMA_URL ?? "https://coins.llama.fi").replace(/\/$/, ""),
    jupiterTokensUrl: (env.JUPITER_TOKENS_URL ?? "https://lite-api.jup.ag/tokens/v2").replace(/\/$/, ""),
    depositWallets: {
      ...(env.DEPOSIT_WALLET_ETHEREUM ? { ethereum: env.DEPOSIT_WALLET_ETHEREUM.trim() } : {}),
      ...(env.DEPOSIT_WALLET_SOLANA ? { solana: env.DEPOSIT_WALLET_SOLANA.trim() } : {}),
      ...(env.DEPOSIT_WALLET_BNB ? { bnb: env.DEPOSIT_WALLET_BNB.trim() } : {}),
      ...(env.DEPOSIT_WALLET_ROBINHOOD ? { robinhood: env.DEPOSIT_WALLET_ROBINHOOD.trim() } : {}),
      ...(env.DEPOSIT_WALLET_BITCOIN ? { bitcoin: env.DEPOSIT_WALLET_BITCOIN.trim() } : {}),
      ...(env.DEPOSIT_WALLET_BASE ? { base: env.DEPOSIT_WALLET_BASE.trim() } : {}),
    },
    depositAllowedTokens: {
      ethereum: new Set([
        ...DEFAULT_ALLOWED_TOKENS_ETHEREUM,
        ...(env.DEPOSIT_ALLOWED_TOKENS_ETHEREUM?.split(",").map((s) => s.trim()).filter(Boolean) ?? []),
      ]),
      solana: new Set([
        ...DEFAULT_ALLOWED_TOKENS_SOLANA,
        ...(env.DEPOSIT_ALLOWED_TOKENS_SOLANA?.split(",").map((s) => s.trim()).filter(Boolean) ?? []),
      ]),
      bnb: new Set([
        ...DEFAULT_ALLOWED_TOKENS_BNB,
        ...(env.DEPOSIT_ALLOWED_TOKENS_BNB?.split(",").map((s) => s.trim()).filter(Boolean) ?? []),
      ]),
      // Robinhood Chain has no USDC/USDT; its default is USDG (see DEFAULT_ALLOWED_TOKENS_ROBINHOOD).
      robinhood: new Set([
        ...DEFAULT_ALLOWED_TOKENS_ROBINHOOD,
        ...(env.DEPOSIT_ALLOWED_TOKENS_ROBINHOOD?.split(",").map((s) => s.trim()).filter(Boolean) ?? []),
      ]),
      // Base: Circle's native USDC only (see DEFAULT_ALLOWED_TOKENS_BASE).
      base: new Set([
        ...DEFAULT_ALLOWED_TOKENS_BASE,
        ...(env.DEPOSIT_ALLOWED_TOKENS_BASE?.split(",").map((s) => s.trim()).filter(Boolean) ?? []),
      ]),
    },
    testHooks: bool(env.SERVER_TEST_HOOKS, false),
    // The `&& !production` is load-bearing: this must never activate on a deployed instance,
    // regardless of what env var a deploy config sets.
    devSkipAuth: bool(env.DEV_SKIP_AUTH, false) && !production,
    logLevel: env.LOG_LEVEL ?? (production ? "info" : "info"),
  };
}
