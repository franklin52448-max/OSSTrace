import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { DEFAULT_ALLOWED_TOKENS_ETHEREUM, DEFAULT_ALLOWED_TOKENS_SOLANA } from "./chain/deposits.ts";

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
  defillamaUrl: string;
  jupiterTokensUrl: string;
  /** Public wallet addresses bounty depositors pay into -- never a key this server holds (ADR 0020). */
  depositWallets: { ethereum?: string; solana?: string };
  /** Assets a bounty deposit may be verified in, beyond each chain's own native currency (always
   *  allowed) -- defaults to real USDC/USDT, extendable per-deployment via
   *  DEPOSIT_ALLOWED_TOKENS_ETHEREUM/_SOLANA (comma-separated, added to the defaults, never replacing
   *  them). Without this, any worthless token a depositor mints themselves would verify as a real
   *  "deposit" (see chain/deposits.ts). */
  depositAllowedTokens: { ethereum: Set<string>; solana: Set<string> };
  /** Enables POST /api/_test/alerts/tick (off unless SERVER_TEST_HOOKS=1). */
  testHooks: boolean;
  /** Local-dev-only: every request is treated as signed in as a fixed fake user, no cookie needed.
   *  Always false when `production` is true, no matter what DEV_SKIP_AUTH is set to -- see loadConfig. */
  devSkipAuth: boolean;
  logLevel: string;
};

export const DEFAULT_SOLANA_RPC = "https://api.mainnet-beta.solana.com";

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

  const solscanApiKey = env.SOLSCAN_API_KEY?.trim() || null;

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
    defillamaUrl: (env.DEFILLAMA_URL ?? "https://coins.llama.fi").replace(/\/$/, ""),
    jupiterTokensUrl: (env.JUPITER_TOKENS_URL ?? "https://lite-api.jup.ag/tokens/v2").replace(/\/$/, ""),
    depositWallets: {
      ...(env.DEPOSIT_WALLET_ETHEREUM ? { ethereum: env.DEPOSIT_WALLET_ETHEREUM.trim() } : {}),
      ...(env.DEPOSIT_WALLET_SOLANA ? { solana: env.DEPOSIT_WALLET_SOLANA.trim() } : {}),
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
    },
    testHooks: bool(env.SERVER_TEST_HOOKS, false),
    // The `&& !production` is load-bearing: this must never activate on a deployed instance,
    // regardless of what env var a deploy config sets.
    devSkipAuth: bool(env.DEV_SKIP_AUTH, false) && !production,
    logLevel: env.LOG_LEVEL ?? (production ? "info" : "info"),
  };
}
