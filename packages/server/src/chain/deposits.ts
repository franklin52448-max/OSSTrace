// Verifies a real on-chain payment toward a bounty's reward (ADR 0009, ADR 0020). This server
// never holds or moves a payout -- a `Deposit` is only ever independently-checked evidence that a
// specific, real transaction paid the configured public wallet, re-checkable by anyone.
//
// Ported from the old standalone @osstrace/bounties service's deposits.ts, with one deliberate
// change: that version made raw `eth_getTransactionReceipt`/`eth_getTransactionByHash`/`eth_call`
// JSON-RPC calls against a dedicated Ethereum RPC URL this server was never configured with (it
// reads Ethereum through Blockscout's REST API instead -- see chain/ethereum.ts). Rewritten here
// against Blockscout's own `/api/v2/transactions/:hash` endpoints so no new RPC secret is needed;
// Blockscout also already resolves a token's real decimals server-side, which is simpler and no
// less correct than the old code's own `decimals()` call.
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
 * Ethereum, via Blockscout's own REST API (no raw JSON-RPC needed -- see module comment). A
 * native transfer is read off the transaction's own `value`/`to`; an ERC-20 deposit is read off
 * Blockscout's own token-transfers list for that transaction, which already includes the token's
 * real decimals -- no separate `decimals()` call needed.
 */
export async function verifyEthereumDeposit(http: HttpClient, blockscoutUrl: string, txHash: string, wallet: string | undefined, budget: Budget): Promise<DepositVerification> {
  if (!wallet) return { ok: false, reason: "not_configured" };
  if (!ETH_TX_HASH_FORMAT.test(txHash)) return { ok: false, reason: "malformed_reference" };

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
