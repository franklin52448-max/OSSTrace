import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { DepositChain } from "@osstrace/contract";
import {
  DEFAULT_ALLOWED_TOKENS_ARBITRUM,
  DEFAULT_ALLOWED_TOKENS_BASE,
  DEFAULT_ALLOWED_TOKENS_BNB,
  DEFAULT_ALLOWED_TOKENS_ETHEREUM,
  DEFAULT_ALLOWED_TOKENS_GNOSIS,
  DEFAULT_ALLOWED_TOKENS_HYPERLIQUID,
  DEFAULT_ALLOWED_TOKENS_LENS,
  DEFAULT_ALLOWED_TOKENS_MYTHOS,
  DEFAULT_ALLOWED_TOKENS_OPTIMISM,
  DEFAULT_ALLOWED_TOKENS_ROBINHOOD,
  DEFAULT_ALLOWED_TOKENS_RONIN,
  DEFAULT_ALLOWED_TOKENS_ROOTSTOCK,
  DEFAULT_ALLOWED_TOKENS_SOLANA,
  DEFAULT_ALLOWED_TOKENS_STORY,
  DEFAULT_ALLOWED_TOKENS_ZETACHAIN,
  DEFAULT_ALLOWED_TOKENS_ZORA,
} from "./chain/deposits.ts";

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
  /** Never logged, never sent to the model. Optional -- the OpenRouter key the Tracer agent
   *  (services/tracerAgent) authenticates its LLM calls with: a key of its own, separate from any
   *  other, so this one feature's spend can be tracked and capped on its own. Unset means the agent
   *  answers 503 not_configured, never a stand-in reply. */
  tracerAgentApiKey: string | null;
  /** OpenRouter model id the Tracer agent calls (TRACER_AGENT_MODEL overrides the default). */
  tracerAgentModel: string;
  ethBlockscoutUrl: string;
  /** Never logged. BNB Smart Chain JSON-RPC: bounty-deposit verification over plain `eth_*` calls, and
   *  -- when it's an Alchemy URL -- address history and balances through Alchemy's enhanced API
   *  (chain/alchemy.ts; Etherscan's free tier refuses chain 56, so there's no free keyless BSC indexer
   *  to read instead). The zero-config default is BNB Chain's own public RPC: deposits work on it,
   *  address lookups report that an Alchemy URL is needed, never an empty wallet. */
  bnbRpcUrl: string;
  /** Never logged. Robinhood Chain JSON-RPC: bounty-deposit verification, and -- when it's an Alchemy
   *  URL -- address history and balances through Alchemy's enhanced API (chain/alchemy.ts). The
   *  chain's own Blockscout instance can't be read instead: it answers every scripted request with a
   *  Cloudflare challenge. The default is the chain's own public RPC (rate-limited, no key): deposits
   *  work on it, address lookups report that an Alchemy URL is needed, never an empty wallet. */
  robinhoodRpcUrl: string;
  /** Never logged. Base JSON-RPC: bounty-deposit verification, and -- when it's an Alchemy URL --
   *  address history and balances through Alchemy's enhanced API (chain/alchemy.ts). base.blockscout.com
   *  challenges every server-side call (HTTP 403, checked 2026-10-23) and Etherscan's free plan refuses
   *  Base. The default is Base's official public endpoint ("not for production" per Base's own docs --
   *  fine for occasional deposit checks): address lookups on it report that an Alchemy URL is needed. */
  baseRpcUrl: string;
  /** Never logged. Arbitrum One, OP Mainnet, Zora, Lens Chain and Data Network JSON-RPC, the same
   *  shape as robinhoodRpcUrl/baseRpcUrl: bounty-deposit verification over plain `eth_*` calls, and --
   *  when it's an Alchemy URL -- address history and balances through Alchemy's enhanced API
   *  (chain/alchemy.ts). Each defaults to that chain's own official public RPC (no key; chain ids
   *  checked against each one 2026-10-23): deposits work on it, address lookups on it report that an
   *  Alchemy URL is needed, never an empty wallet. Unlike Ethereum mainnet, each of these chains'
   *  operators runs a public endpoint of its own, so there is a safe zero-config default to give. */
  arbitrumRpcUrl: string;
  optimismRpcUrl: string;
  zoraRpcUrl: string;
  lensRpcUrl: string;
  /** Data Network (formerly Story): the chain's id here is "story", so its env var is STORY_RPC_URL. */
  storyRpcUrl: string;
  /** Never logged. Gnosis Chain, Ronin and Rootstock JSON-RPC, the same shape again (deposits over
   *  plain `eth_*`, address history and balances when it's an Alchemy URL). Each defaults to the
   *  chain's own operator's public RPC (no key; chain ids 100 / 2020 / 30 checked against each one
   *  2026-10-23). */
  gnosisRpcUrl: string;
  roninRpcUrl: string;
  rootstockRpcUrl: string;
  /** Never logged. ZetaChain, Mythos and HyperEVM JSON-RPC, the same shape again. Each defaults to a
   *  keyless public RPC the chain's own operator publishes (chain ids 7000 / 42018 / 999 checked against
   *  each one 2026-10-23); address lookups need an Alchemy URL with a key. */
  zetachainRpcUrl: string;
  mythosRpcUrl: string;
  hyperliquidRpcUrl: string;
  /** Bitcoin bounty-deposit verification source (an Esplora-API block explorer, no key needed) --
   *  Blockstream.info by default; mempool.space speaks the same API and can be swapped in via
   *  ESPLORA_URL. Bitcoin is deposit-only here: nothing else in this server reads Bitcoin. */
  esploraUrl: string;
  defillamaUrl: string;
  jupiterTokensUrl: string;
  /** Public wallet addresses bounty depositors pay into -- never a key this server holds (ADR 0020). */
  depositWallets: Partial<Record<DepositChain, string>>;
  /** Assets a bounty deposit may be verified in, beyond each chain's own native currency (always
   *  allowed) -- defaults to real USDC/USDT (Base, Arbitrum One, OP Mainnet, HyperEVM: USDC only;
   *  Robinhood Chain: USDG; Zora, Lens Chain, Data Network, Gnosis Chain, Ronin, Rootstock, ZetaChain,
   *  Mythos: none, native only), extendable per-deployment via DEPOSIT_ALLOWED_TOKENS_<CHAIN> (ETHEREUM,
   *  SOLANA, BNB, ROBINHOOD, BASE, ARBITRUM, OPTIMISM, ZORA, LENS, STORY, GNOSIS, RONIN, ROOTSTOCK,
   *  ZETACHAIN, MYTHOS, HYPERLIQUID; comma-separated, added to the defaults, never replacing them). Without this, any
   *  worthless token a depositor mints themselves would verify as a real "deposit" (see
   *  chain/deposits.ts). */
  depositAllowedTokens: Record<Exclude<DepositChain, "bitcoin">, Set<string>>;
  /** Enables POST /api/_test/alerts/tick (off unless SERVER_TEST_HOOKS=1). */
  testHooks: boolean;
  /** Local-dev-only: every request is treated as signed in as a fixed fake user, no cookie needed.
   *  Always false when `production` is true, no matter what DEV_SKIP_AUTH is set to -- see loadConfig. */
  devSkipAuth: boolean;
  logLevel: string;
};

/**
 * The Tracer agent's default model. Chosen for (1) reliable OpenAI-style function calling -- the
 * agent can only act through tool calls, so a model that answers in prose instead of calling a
 * tool, or emits malformed arguments, simply fails the feature, and this is OpenAI's own
 * function-calling format natively rather than a translation of it; (2) price -- $0.40 / $1.60 per
 * million input/output tokens on OpenRouter (checked against its public /models listing,
 * 2026-10-23), cheap enough to offer anon visitors a few free messages; (3) not a reasoning model,
 * so the per-call token budget goes to the answer, not hidden thinking that can eat the whole
 * budget before a reply. Pinned to a concrete version, not a `~...-latest` alias, so behaviour
 * doesn't change underneath a deployment. TRACER_AGENT_MODEL swaps it without a code change.
 */
export const DEFAULT_TRACER_AGENT_MODEL = "openai/gpt-4.1-mini";

export const DEFAULT_SOLANA_RPC = "https://api.mainnet-beta.solana.com";
/** BNB Chain's own public dataseed endpoint (no key). */
export const DEFAULT_BNB_RPC = "https://bsc-dataseed.bnbchain.org";
/** Robinhood Chain's own public mainnet RPC (chain id 4663, no key, rate-limited). */
export const DEFAULT_ROBINHOOD_RPC = "https://rpc.mainnet.chain.robinhood.com";
/** Base's own official public RPC (chain id 8453, no key). */
export const DEFAULT_BASE_RPC = "https://mainnet.base.org";
/** Arbitrum One's public RPC, run by Offchain Labs (chain id 42161, no key, rate-limited). */
export const DEFAULT_ARBITRUM_RPC = "https://arb1.arbitrum.io/rpc";
/** OP Mainnet's public RPC, run by the Optimism Foundation (chain id 10, no key, rate-limited). */
export const DEFAULT_OPTIMISM_RPC = "https://mainnet.optimism.io";
/** Zora's own public RPC (chain id 7777777, no key). */
export const DEFAULT_ZORA_RPC = "https://rpc.zora.energy";
/** Lens Chain's own public RPC (chain id 232, no key). */
export const DEFAULT_LENS_RPC = "https://rpc.lens.xyz";
/** The Data Network's own public RPC (chain id 1514, no key) -- the rebranded name of Story's
 *  mainnet.storyrpc.io, which answers for the same chain. */
export const DEFAULT_STORY_RPC = "https://mainnet.datarpc.io";
/** Gnosis Chain's own public RPC, listed in Gnosis's docs (chain id 100, no key, rate-limited). */
export const DEFAULT_GNOSIS_RPC = "https://rpc.gnosischain.com";
/** Ronin's public RPC, run by Sky Mavis (chain id 2020, no key, rate-limited). */
export const DEFAULT_RONIN_RPC = "https://api.roninchain.com/rpc";
/** Rootstock's public node, run by RootstockLabs (chain id 30, no key, rate-limited). */
export const DEFAULT_ROOTSTOCK_RPC = "https://public-node.rsk.co";
/** ZetaChain's mainnet EVM RPC as ZetaChain's own docs list it (BlockPI's public endpoint; chain id 7000,
 *  no key, rate-limited). */
export const DEFAULT_ZETACHAIN_RPC = "https://zetachain-evm.blockpi.network/v1/rpc/public";
/** Mythos's public RPC, the one its own explorer (mythos-mainnet.explorer.alchemy.com) publishes (chain id
 *  42018, no key). It is Alchemy-hosted but serves core `eth_*` calls only -- it refuses Alchemy's
 *  enhanced API ("Only core evm requests are allowed"), so lookups still need a keyed Alchemy URL. */
export const DEFAULT_MYTHOS_RPC = "https://mythos-mainnet.g.alchemy.com/public";
/** The HyperEVM's own public RPC, from Hyperliquid's docs (chain id 999, no key, rate-limited). */
export const DEFAULT_HYPERLIQUID_RPC = "https://rpc.hyperliquid.xyz/evm";

const bool = (v: string | undefined, dflt: boolean) => {
  if (v === undefined || v === "") return dflt;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
};

const expandHome = (p: string) => (p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p);

/** A comma-separated DEPOSIT_ALLOWED_TOKENS_* value as its entries. */
const extraTokens = (v: string | undefined) => v?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];

/** `<NAME>_RPC_URL_FILE` (a file holding only the URL, which may embed a key) wins over
 *  `<NAME>_RPC_URL`; neither set means `dflt`. The same split bnbRpcUrl/robinhoodRpcUrl/baseRpcUrl use. */
function rpcUrlFrom(env: NodeJS.ProcessEnv, name: string, dflt: string): string {
  const file = env[`${name}_RPC_URL_FILE`];
  if (file) {
    const raw = readFileSync(expandHome(file), "utf8").trim();
    if (!/^https?:\/\//.test(raw)) throw new Error(`${name}_RPC_URL_FILE does not contain an http(s) URL`);
    return raw;
  }
  return env[`${name}_RPC_URL`]?.trim() || dflt;
}

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

  const arbitrumRpcUrl = rpcUrlFrom(env, "ARBITRUM", DEFAULT_ARBITRUM_RPC);
  const optimismRpcUrl = rpcUrlFrom(env, "OPTIMISM", DEFAULT_OPTIMISM_RPC);
  const zoraRpcUrl = rpcUrlFrom(env, "ZORA", DEFAULT_ZORA_RPC);
  const lensRpcUrl = rpcUrlFrom(env, "LENS", DEFAULT_LENS_RPC);
  const storyRpcUrl = rpcUrlFrom(env, "STORY", DEFAULT_STORY_RPC);
  const gnosisRpcUrl = rpcUrlFrom(env, "GNOSIS", DEFAULT_GNOSIS_RPC);
  const roninRpcUrl = rpcUrlFrom(env, "RONIN", DEFAULT_RONIN_RPC);
  const rootstockRpcUrl = rpcUrlFrom(env, "ROOTSTOCK", DEFAULT_ROOTSTOCK_RPC);
  const zetachainRpcUrl = rpcUrlFrom(env, "ZETACHAIN", DEFAULT_ZETACHAIN_RPC);
  const mythosRpcUrl = rpcUrlFrom(env, "MYTHOS", DEFAULT_MYTHOS_RPC);
  const hyperliquidRpcUrl = rpcUrlFrom(env, "HYPERLIQUID", DEFAULT_HYPERLIQUID_RPC);

  const solscanApiKey = env.SOLSCAN_API_KEY?.trim() || null;
  const tracerAgentApiKey = env.OPENROUTER_API_KEY_TRACER_AGENT?.trim() || null;
  const tracerAgentModel = env.TRACER_AGENT_MODEL?.trim() || DEFAULT_TRACER_AGENT_MODEL;

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
    tracerAgentApiKey,
    tracerAgentModel,
    ethBlockscoutUrl: (env.ETH_BLOCKSCOUT_URL ?? "https://eth.blockscout.com").replace(/\/$/, ""),
    bnbRpcUrl,
    robinhoodRpcUrl,
    baseRpcUrl,
    arbitrumRpcUrl,
    optimismRpcUrl,
    zoraRpcUrl,
    lensRpcUrl,
    storyRpcUrl,
    gnosisRpcUrl,
    roninRpcUrl,
    rootstockRpcUrl,
    zetachainRpcUrl,
    mythosRpcUrl,
    hyperliquidRpcUrl,
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
      ...(env.DEPOSIT_WALLET_ARBITRUM ? { arbitrum: env.DEPOSIT_WALLET_ARBITRUM.trim() } : {}),
      ...(env.DEPOSIT_WALLET_OPTIMISM ? { optimism: env.DEPOSIT_WALLET_OPTIMISM.trim() } : {}),
      ...(env.DEPOSIT_WALLET_ZORA ? { zora: env.DEPOSIT_WALLET_ZORA.trim() } : {}),
      ...(env.DEPOSIT_WALLET_LENS ? { lens: env.DEPOSIT_WALLET_LENS.trim() } : {}),
      ...(env.DEPOSIT_WALLET_STORY ? { story: env.DEPOSIT_WALLET_STORY.trim() } : {}),
      ...(env.DEPOSIT_WALLET_GNOSIS ? { gnosis: env.DEPOSIT_WALLET_GNOSIS.trim() } : {}),
      ...(env.DEPOSIT_WALLET_RONIN ? { ronin: env.DEPOSIT_WALLET_RONIN.trim() } : {}),
      ...(env.DEPOSIT_WALLET_ROOTSTOCK ? { rootstock: env.DEPOSIT_WALLET_ROOTSTOCK.trim() } : {}),
      ...(env.DEPOSIT_WALLET_ZETACHAIN ? { zetachain: env.DEPOSIT_WALLET_ZETACHAIN.trim() } : {}),
      ...(env.DEPOSIT_WALLET_MYTHOS ? { mythos: env.DEPOSIT_WALLET_MYTHOS.trim() } : {}),
      ...(env.DEPOSIT_WALLET_HYPERLIQUID ? { hyperliquid: env.DEPOSIT_WALLET_HYPERLIQUID.trim() } : {}),
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
      // Arbitrum One / OP Mainnet: Circle's native USDC only; Zora, Lens Chain, Data Network: none by
      // default (see deposits.ts).
      arbitrum: new Set([...DEFAULT_ALLOWED_TOKENS_ARBITRUM, ...extraTokens(env.DEPOSIT_ALLOWED_TOKENS_ARBITRUM)]),
      optimism: new Set([...DEFAULT_ALLOWED_TOKENS_OPTIMISM, ...extraTokens(env.DEPOSIT_ALLOWED_TOKENS_OPTIMISM)]),
      zora: new Set([...DEFAULT_ALLOWED_TOKENS_ZORA, ...extraTokens(env.DEPOSIT_ALLOWED_TOKENS_ZORA)]),
      lens: new Set([...DEFAULT_ALLOWED_TOKENS_LENS, ...extraTokens(env.DEPOSIT_ALLOWED_TOKENS_LENS)]),
      story: new Set([...DEFAULT_ALLOWED_TOKENS_STORY, ...extraTokens(env.DEPOSIT_ALLOWED_TOKENS_STORY)]),
      // Gnosis Chain, Ronin, Rootstock: none by default either (see deposits.ts).
      gnosis: new Set([...DEFAULT_ALLOWED_TOKENS_GNOSIS, ...extraTokens(env.DEPOSIT_ALLOWED_TOKENS_GNOSIS)]),
      ronin: new Set([...DEFAULT_ALLOWED_TOKENS_RONIN, ...extraTokens(env.DEPOSIT_ALLOWED_TOKENS_RONIN)]),
      rootstock: new Set([...DEFAULT_ALLOWED_TOKENS_ROOTSTOCK, ...extraTokens(env.DEPOSIT_ALLOWED_TOKENS_ROOTSTOCK)]),
      // ZetaChain, Mythos: none by default; the HyperEVM: Circle's native USDC only (see deposits.ts).
      zetachain: new Set([...DEFAULT_ALLOWED_TOKENS_ZETACHAIN, ...extraTokens(env.DEPOSIT_ALLOWED_TOKENS_ZETACHAIN)]),
      mythos: new Set([...DEFAULT_ALLOWED_TOKENS_MYTHOS, ...extraTokens(env.DEPOSIT_ALLOWED_TOKENS_MYTHOS)]),
      hyperliquid: new Set([...DEFAULT_ALLOWED_TOKENS_HYPERLIQUID, ...extraTokens(env.DEPOSIT_ALLOWED_TOKENS_HYPERLIQUID)]),
    },
    testHooks: bool(env.SERVER_TEST_HOOKS, false),
    // The `&& !production` is load-bearing: this must never activate on a deployed instance,
    // regardless of what env var a deploy config sets.
    devSkipAuth: bool(env.DEV_SKIP_AUTH, false) && !production,
    logLevel: env.LOG_LEVEL ?? (production ? "info" : "info"),
  };
}
