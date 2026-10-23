// Verifies a real on-chain payment toward a bounty's reward (ADR 0009, ADR 0020). This server
// never holds or moves a payout -- a `Deposit` is only ever independently-checked evidence that a
// specific, real transaction paid the configured public wallet, re-checkable by anyone.
//
// Ethereum has two verification paths now. When a dedicated `ETH_RPC_URL` is configured (see
// config.ts), deposits are checked via real `eth_getTransactionByHash`/`eth_getTransactionReceipt`
// JSON-RPC calls -- the same approach the old standalone @osstrace/bounties service originally
// used, before this server existed. When it isn't configured (the zero-config default -- no
// Ethereum mainnet public RPC is reliable enough to hardcode the way Solana's is), it falls back
// to Blockscout's own `/api/v2/transactions/:hash` REST endpoints, which need no RPC secret at
// all and already resolve a token's real decimals server-side.
import { formatUnits } from "./amount.ts";
import { HttpClient, type Budget } from "../lib/http.ts";

const SOL_DECIMALS = 9;

export type DepositAsset = "native" | { contract: string };

export interface VerifiedDeposit {
  asset: DepositAsset;
  amount: string;
  fromAddress: string;
  toWallet: string;
  memo?: string;
}

export type DepositVerification =
  | { ok: true; deposit: VerifiedDeposit }
  | { ok: false; reason: "not_configured" | "not_found" | "not_confirmed" | "wrong_wallet" | "unsupported_asset" | "malformed_reference" };

const SOLANA_SIGNATURE_FORMAT = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const ETH_TX_HASH_FORMAT = /^0x[0-9a-fA-F]{64}$/;
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The real USDC/USDT mint (Solana) and contract (Ethereum) addresses -- not this project's own
 * invention. `verifySolanaDeposit`/`verifyEthereumDeposit` only count a token deposit toward a
 * bounty when its asset is on this list (native SOL/ETH is always allowed): without it, anyone can
 * deploy a worthless token, send a huge raw amount of it to the deposit wallet for a fraction of a
 * cent, and have it show as a "verified" deposit chip indistinguishable from a real one -- "verified"
 * is supposed to mean the deposit is actually worth something, not just that a transfer happened
 * (ADR 0020). An operator can allow more assets via config (see config.ts's depositAllowedTokens). */
export const DEFAULT_ALLOWED_TOKENS_ETHEREUM = new Set<string>([
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
  "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
]);
export const DEFAULT_ALLOWED_TOKENS_SOLANA = new Set<string>([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);
const isAllowedEthToken = (allowed: Set<string>, contract: string) => [...allowed].some((a) => sameAddress(a, contract));

/** The real, public SPL Memo program -- not this project's own invention. */
const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

type ParsedIx = { program?: string; programId: string; parsed?: unknown };
type TokenBal = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } };
type SolTx = {
  transaction: { message: { accountKeys: ({ pubkey: string } | string)[]; instructions: ParsedIx[] } };
  meta: {
    err: unknown;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBal[] | null;
    postTokenBalances?: TokenBal[] | null;
    innerInstructions?: { instructions: ParsedIx[] }[] | null;
  } | null;
};

const keyOf = (k: { pubkey: string } | string) => (typeof k === "string" ? k : k.pubkey);

function extractMemo(tx: SolTx): string | undefined {
  const all = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions?.flatMap((i) => i.instructions) ?? [])];
  for (const ix of all) {
    if (ix.programId !== MEMO_PROGRAM_ID) continue;
    if (typeof ix.parsed === "string" && ix.parsed.length > 0) return ix.parsed;
  }
  return undefined;
}

/**
 * Solana: a raw `getParsedTransaction` RPC call against this server's already-configured
 * `config.solanaRpcUrl` (same HttpClient conventions as chain/solana.ts). Native SOL is read off
 * the real pre/post balance delta of the configured wallet's account; an SPL/Token-2022 transfer
 * is read off the real pre/post token-balance delta for an account owned by that wallet.
 */
export async function verifySolanaDeposit(http: HttpClient, rpcUrl: string, signature: string, wallet: string | undefined, allowedTokens: Set<string>, budget: Budget): Promise<DepositVerification> {
  if (!wallet) return { ok: false, reason: "not_configured" };
  if (!SOLANA_SIGNATURE_FORMAT.test(signature)) return { ok: false, reason: "malformed_reference" };

  let tx: SolTx | null;
  try {
    const { data } = await http.json<{ result: SolTx | null }>(rpcUrl, {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "getParsedTransaction", params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }] },
      budget,
    });
    tx = data.result;
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (!tx || !tx.meta) return { ok: false, reason: "not_found" };
  if (tx.meta.err !== null) return { ok: false, reason: "not_confirmed" };

  const memo = extractMemo(tx);
  const keys = tx.transaction.message.accountKeys.map(keyOf);
  const walletIdx = keys.indexOf(wallet);
  if (walletIdx >= 0) {
    const delta = (tx.meta.postBalances[walletIdx] ?? 0) - (tx.meta.preBalances[walletIdx] ?? 0);
    if (delta > 0) {
      return { ok: true, deposit: { asset: "native", amount: formatUnits(String(delta), SOL_DECIMALS), fromAddress: keys[0] ?? "unknown", toWallet: wallet, ...(memo ? { memo } : {}) } };
    }
  }

  const pre = new Map((tx.meta.preTokenBalances ?? []).filter((b) => b.owner === wallet).map((b) => [`${b.accountIndex}:${b.mint}`, BigInt(b.uiTokenAmount.amount)]));
  let sawDisallowedIncrease = false;
  for (const post of (tx.meta.postTokenBalances ?? []).filter((b) => b.owner === wallet)) {
    const key = `${post.accountIndex}:${post.mint}`;
    const before = pre.get(key) ?? 0n;
    const after = BigInt(post.uiTokenAmount.amount);
    if (after <= before) continue;
    // Don't take the first increase regardless of asset -- a tx can carry an unrelated/junk token
    // transfer alongside (or instead of) a real one; keep scanning for an allowed asset before
    // giving up, same reasoning as the Ethereum paths below.
    if (!allowedTokens.has(post.mint)) {
      sawDisallowedIncrease = true;
      continue;
    }
    return {
      ok: true,
      deposit: { asset: { contract: post.mint }, amount: formatUnits(String(after - before), post.uiTokenAmount.decimals), fromAddress: keys[0] ?? "unknown", toWallet: wallet, ...(memo ? { memo } : {}) },
    };
  }

  return { ok: false, reason: sawDisallowedIncrease ? "unsupported_asset" : "wrong_wallet" };
}

type BsTx = { status: string | null; value: string; to: { hash: string } | null; from: { hash: string } | null };
type BsTokenTransfer = { to: { hash: string } | null; from: { hash: string } | null; token: { address_hash: string; decimals: string | null }; total: { value?: string | null } | null };
type BsPage<T> = { items: T[] };

/**
 * Ethereum, via Blockscout's own REST API -- the zero-config fallback when no `ETH_RPC_URL` is
 * set (see verifyEthereumDeposit below). A native transfer is read off the transaction's own
 * `value`/`to`; an ERC-20 deposit is read off Blockscout's own token-transfers list for that
 * transaction, which already includes the token's real decimals -- no separate `decimals()` call
 * needed.
 */
async function verifyEthereumDepositViaBlockscout(http: HttpClient, blockscoutUrl: string, txHash: string, wallet: string, allowedTokens: Set<string>, budget: Budget): Promise<DepositVerification> {
  let tx: BsTx;
  try {
    const { data } = await http.json<BsTx>(`${blockscoutUrl}/api/v2/transactions/${txHash}`, { budget });
    tx = data;
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (tx.status !== "ok") return { ok: false, reason: tx.status === null ? "not_found" : "not_confirmed" };

  if (tx.to && sameAddress(tx.to.hash, wallet) && BigInt(tx.value || "0") > 0n) {
    return { ok: true, deposit: { asset: "native", amount: formatUnits(tx.value, 18), fromAddress: tx.from?.hash ?? "unknown", toWallet: wallet } };
  }

  let transfers: BsPage<BsTokenTransfer>;
  try {
    const { data } = await http.json<BsPage<BsTokenTransfer>>(`${blockscoutUrl}/api/v2/transactions/${txHash}/token-transfers`, { budget });
    transfers = data;
  } catch {
    return { ok: false, reason: "wrong_wallet" };
  }
  const candidates = transfers.items.filter((t) => t.to && sameAddress(t.to.hash, wallet) && t.total?.value);
  if (candidates.length === 0) return { ok: false, reason: "wrong_wallet" };
  const match = candidates.find((t) => isAllowedEthToken(allowedTokens, t.token.address_hash));
  if (!match) return { ok: false, reason: "unsupported_asset" };
  return {
    ok: true,
    deposit: {
      asset: { contract: match.token.address_hash },
      amount: formatUnits(match.total!.value!, Number(match.token.decimals ?? "18")),
      fromAddress: match.from?.hash ?? "unknown",
      toWallet: wallet,
    },
  };
}

type EthRpcTx = { to: string | null; from: string; value: string; blockNumber: string | null } | null;
type EthRpcLog = { address: string; topics: string[]; data: string };
type EthRpcReceipt = { status: string | null; logs: EthRpcLog[] } | null;

// keccak256("Transfer(address,address,uint256)") -- the standard ERC-20 Transfer event topic, not
// this project's own invention.
const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicToAddress = (topic: string) => `0x${topic.slice(-40)}`;

async function ethRpc<T>(http: HttpClient, rpcUrl: string, method: string, params: unknown[], budget: Budget): Promise<T> {
  const { data } = await http.json<{ result: T; error?: { message: string } }>(rpcUrl, { method: "POST", body: { jsonrpc: "2.0", id: 1, method, params }, budget });
  if (data.error) throw new Error(`${method}: ${data.error.message}`);
  return data.result;
}

/** A token's on-chain `decimals()` (selector 0x313ce567), via `eth_call` -- same as the old
 *  standalone service used to, before this server read Ethereum through Blockscout. */
async function fetchDecimals(http: HttpClient, rpcUrl: string, contract: string, budget: Budget): Promise<number> {
  try {
    const result = await ethRpc<string>(http, rpcUrl, "eth_call", [{ to: contract, data: "0x313ce567" }, "latest"], budget);
    return parseInt(result, 16);
  } catch {
    return 18; // most ERC-20s are 18; a failed decimals() call shouldn't block an otherwise-verified deposit.
  }
}

/**
 * Ethereum, via a dedicated RPC (`eth_getTransactionByHash`/`eth_getTransactionReceipt`/`eth_call`)
 * when `ETH_RPC_URL` is configured -- faster and more reliable than the public Blockscout fallback
 * under load. A native transfer is read off the transaction's own `value`/`to`; an ERC-20 deposit
 * is read off the real Transfer event log in the transaction's receipt, with the token's real
 * decimals resolved via its own `decimals()`.
 */
async function verifyEthereumDepositViaRpc(http: HttpClient, rpcUrl: string, txHash: string, wallet: string, allowedTokens: Set<string>, budget: Budget): Promise<DepositVerification> {
  let tx: EthRpcTx;
  let receipt: EthRpcReceipt;
  try {
    [tx, receipt] = await Promise.all([
      ethRpc<EthRpcTx>(http, rpcUrl, "eth_getTransactionByHash", [txHash], budget),
      ethRpc<EthRpcReceipt>(http, rpcUrl, "eth_getTransactionReceipt", [txHash], budget),
    ]);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (!tx || !receipt) return { ok: false, reason: "not_found" };
  if (receipt.status !== "0x1") return { ok: false, reason: "not_confirmed" };

  if (tx.to && sameAddress(tx.to, wallet) && BigInt(tx.value) > 0n) {
    return { ok: true, deposit: { asset: "native", amount: formatUnits(BigInt(tx.value).toString(), 18), fromAddress: tx.from, toWallet: wallet } };
  }

  const candidates = receipt.logs.filter((l) => l.topics[0] === ERC20_TRANSFER_TOPIC && l.topics.length === 3 && sameAddress(topicToAddress(l.topics[2]!), wallet));
  if (candidates.length === 0) return { ok: false, reason: "wrong_wallet" };
  const match = candidates.find((l) => isAllowedEthToken(allowedTokens, l.address));
  if (!match) return { ok: false, reason: "unsupported_asset" };
  const decimals = await fetchDecimals(http, rpcUrl, match.address, budget);
  return {
    ok: true,
    deposit: { asset: { contract: match.address }, amount: formatUnits(BigInt(match.data).toString(), decimals), fromAddress: topicToAddress(match.topics[1]!), toWallet: wallet },
  };
}

/** Prefers `ethRpcUrl` when the operator configured one; falls back to Blockscout (no key needed)
 *  otherwise -- the same configured-RPC-with-a-zero-config-fallback shape as Solana already uses. */
export async function verifyEthereumDeposit(http: HttpClient, blockscoutUrl: string, ethRpcUrl: string | null, txHash: string, wallet: string | undefined, allowedTokens: Set<string>, budget: Budget): Promise<DepositVerification> {
  if (!wallet) return { ok: false, reason: "not_configured" };
  if (!ETH_TX_HASH_FORMAT.test(txHash)) return { ok: false, reason: "malformed_reference" };
  return ethRpcUrl
    ? verifyEthereumDepositViaRpc(http, ethRpcUrl, txHash, wallet, allowedTokens, budget)
    : verifyEthereumDepositViaBlockscout(http, blockscoutUrl, txHash, wallet, allowedTokens, budget);
}

const BTC_TXID_FORMAT = /^[0-9a-fA-F]{64}$/;
const BTC_DECIMALS = 8;

type EsploraVout = { scriptpubkey_address?: string; value: number };
type EsploraVin = { prevout?: { scriptpubkey_address?: string } };
type EsploraTx = { status: { confirmed: boolean }; vin: EsploraVin[]; vout: EsploraVout[] };

/**
 * Bitcoin, via a public Esplora-API block explorer (Blockstream.info by default, mempool.space is
 * API-compatible and configurable instead) -- no RPC/node/key needed, same zero-config-REST-fallback
 * shape as Ethereum's Blockscout path. There's deliberately no per-asset allowlist here the way ETH
 * and Solana have one: Bitcoin's base chain has no general fungible-token standard the way SPL/ERC-20
 * do, so every real BTC payment is the same native asset -- nothing to be "a worthless token" of.
 *
 * No sender-ownership check either (unlike verifyEthereumDeposit/verifySolanaDeposit, see
 * routes/bounties.ts): Bitcoin has no browser wallet-connect standard this project's accounts can
 * sign in with, and a BTC transaction doesn't have one clean "sender" the way an ETH/SOL account-model
 * tx does -- multiple inputs, no signing authority recoverable from the tx alone the way ecrecover
 * works for Ethereum. A BTC deposit is accepted as "someone" paying the configured wallet, the same
 * trust level as anyone citing a public payment -- `fromAddress` below is best-effort (the first
 * input's own previous output address, when Esplora resolves it) for display only, never checked
 * against the signed-in caller.
 */
export async function verifyBitcoinDeposit(http: HttpClient, esploraUrl: string, txid: string, wallet: string | undefined, budget: Budget): Promise<DepositVerification> {
  if (!wallet) return { ok: false, reason: "not_configured" };
  if (!BTC_TXID_FORMAT.test(txid)) return { ok: false, reason: "malformed_reference" };

  let tx: EsploraTx;
  try {
    const { data } = await http.json<EsploraTx>(`${esploraUrl}/api/tx/${txid}`, { budget });
    tx = data;
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (!tx.status.confirmed) return { ok: false, reason: "not_confirmed" };

  const paidSats = tx.vout.filter((v) => v.scriptpubkey_address && sameAddress(v.scriptpubkey_address, wallet)).reduce((sum, v) => sum + v.value, 0);
  if (paidSats <= 0) return { ok: false, reason: "wrong_wallet" };

  return {
    ok: true,
    deposit: { asset: "native", amount: formatUnits(String(paidSats), BTC_DECIMALS), fromAddress: tx.vin[0]?.prevout?.scriptpubkey_address ?? "unknown", toWallet: wallet },
  };
}
