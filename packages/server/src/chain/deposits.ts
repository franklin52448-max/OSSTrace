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
  | { ok: false; reason: "not_configured" | "not_found" | "not_confirmed" | "wrong_wallet" | "malformed_reference" };

const SOLANA_SIGNATURE_FORMAT = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const ETH_TX_HASH_FORMAT = /^0x[0-9a-fA-F]{64}$/;
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

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
export async function verifySolanaDeposit(http: HttpClient, rpcUrl: string, signature: string, wallet: string | undefined, budget: Budget): Promise<DepositVerification> {
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
  for (const post of (tx.meta.postTokenBalances ?? []).filter((b) => b.owner === wallet)) {
    const key = `${post.accountIndex}:${post.mint}`;
    const before = pre.get(key) ?? 0n;
    const after = BigInt(post.uiTokenAmount.amount);
    if (after > before) {
      return {
        ok: true,
        deposit: { asset: { contract: post.mint }, amount: formatUnits(String(after - before), post.uiTokenAmount.decimals), fromAddress: keys[0] ?? "unknown", toWallet: wallet, ...(memo ? { memo } : {}) },
      };
    }
  }

  return { ok: false, reason: "wrong_wallet" };
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
async function verifyEthereumDepositViaBlockscout(http: HttpClient, blockscoutUrl: string, txHash: string, wallet: string, budget: Budget): Promise<DepositVerification> {
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
  const match = transfers.items.find((t) => t.to && sameAddress(t.to.hash, wallet) && t.total?.value);
  if (!match) return { ok: false, reason: "wrong_wallet" };
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
async function verifyEthereumDepositViaRpc(http: HttpClient, rpcUrl: string, txHash: string, wallet: string, budget: Budget): Promise<DepositVerification> {
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

  const match = receipt.logs.find((l) => l.topics[0] === ERC20_TRANSFER_TOPIC && l.topics.length === 3 && sameAddress(topicToAddress(l.topics[2]!), wallet));
  if (!match) return { ok: false, reason: "wrong_wallet" };
  const decimals = await fetchDecimals(http, rpcUrl, match.address, budget);
  return {
    ok: true,
    deposit: { asset: { contract: match.address }, amount: formatUnits(BigInt(match.data).toString(), decimals), fromAddress: topicToAddress(match.topics[1]!), toWallet: wallet },
  };
}

/** Prefers `ethRpcUrl` when the operator configured one; falls back to Blockscout (no key needed)
 *  otherwise -- the same configured-RPC-with-a-zero-config-fallback shape as Solana already uses. */
export async function verifyEthereumDeposit(http: HttpClient, blockscoutUrl: string, ethRpcUrl: string | null, txHash: string, wallet: string | undefined, budget: Budget): Promise<DepositVerification> {
  if (!wallet) return { ok: false, reason: "not_configured" };
  if (!ETH_TX_HASH_FORMAT.test(txHash)) return { ok: false, reason: "malformed_reference" };
  return ethRpcUrl ? verifyEthereumDepositViaRpc(http, ethRpcUrl, txHash, wallet, budget) : verifyEthereumDepositViaBlockscout(http, blockscoutUrl, txHash, wallet, budget);
}
