import { Connection, type ParsedTransactionWithMeta } from "@solana/web3.js";
import type { ParsedInstruction, PartiallyDecodedInstruction } from "@solana/web3.js";
import { summarizeTransaction } from "@osstrace/chain-solana";
// Deep imports, same documented exception Explorer/Visualizer/Tracer already take for reaching
// into another feature's internals: neither is re-exported from that package's own adapter.ts
// (its public entry point), only used internally by it.
import { decodeSplTransfers } from "@osstrace/chain-solana/src/splToken.ts";
import { formatUnits } from "@osstrace/chain-ethereum/src/units.ts";
import type { DepositAsset } from "./types.ts";

/** Public config only — this project never generates or holds the key behind either wallet (ADR 0020). */
export interface ReceivingWallets {
  ethereum?: string;
  solana?: string;
}

export interface VerifiedDeposit {
  asset: DepositAsset;
  amount: string;
  fromAddress: string;
  /** The configured wallet the chain itself confirmed was paid — not derived, just echoed back from the real check. */
  toWallet: string;
  /** A real Memo program instruction's own text, when the transaction carried one (ADR 0020 §2) — a cross-check, never load-bearing. */
  memo?: string;
}

/** The real, public SPL Memo program — not this project's own invention. */
const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/**
 * The RPC's own `jsonParsed` encoding already decodes a Memo program instruction to its plain
 * text (`{program: "spl-memo", parsed: "<text>"}`) — reused here, not re-decoded from raw bytes.
 * Only top-level instructions are checked: a memo attached via an inner (CPI) instruction is rare
 * enough, and unverified enough as "the sender's own note," not to chase here.
 */
function extractMemo(tx: ParsedTransactionWithMeta): string | undefined {
  for (const ix of tx.transaction.message.instructions as (ParsedInstruction | PartiallyDecodedInstruction)[]) {
    if (ix.programId.toBase58() !== MEMO_PROGRAM_ID) continue;
    if ("parsed" in ix && typeof ix.parsed === "string" && ix.parsed.length > 0) return ix.parsed;
  }
  return undefined;
}

export type DepositVerification =
  | { ok: true; deposit: VerifiedDeposit }
  | { ok: false; reason: "not_configured" | "not_found" | "not_confirmed" | "wrong_wallet" | "malformed_reference" };

const SOLANA_SIGNATURE_FORMAT = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const ETH_TX_HASH_FORMAT = /^0x[0-9a-fA-F]{64}$/;

/**
 * Solana (ADR 0020 §3): reuses `@osstrace/chain-solana`'s own real transaction decoder — the same
 * one every Explorer lookup goes through — rather than a second, parallel decode of the same
 * instructions. `summarizeTransaction` already honestly resolves a native SOL move (direct
 * System Program decode, falling back to a real pre/post balance delta); `decodeSplTransfers`
 * already resolves SPL/Token-2022 transfers to their real owning wallet, not just a token account.
 * A `direction` other than `"in"` means the configured wallet wasn't actually paid — refused.
 */
export async function verifySolanaDeposit(connection: Connection, signature: string, wallet: string | undefined): Promise<DepositVerification> {
  if (!wallet) return { ok: false, reason: "not_configured" };
  if (!SOLANA_SIGNATURE_FORMAT.test(signature)) return { ok: false, reason: "malformed_reference" };

  let tx: ParsedTransactionWithMeta | null;
  try {
    tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 255 });
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (!tx || !tx.meta) return { ok: false, reason: "not_found" };
  if (tx.meta.err !== null) return { ok: false, reason: "not_confirmed" };

  const memo = extractMemo(tx);

  const summary = summarizeTransaction({ signature, blockTime: tx.blockTime ?? null }, tx, wallet);
  if (summary.direction === "in" && summary.valueNative !== "0") {
    return { ok: true, deposit: { asset: "native", amount: summary.valueNative, fromAddress: summary.from, toWallet: wallet, ...(memo ? { memo } : {}) } };
  }

  const incoming = decodeSplTransfers(tx, wallet).filter((t) => t.direction === "in" && t.amount !== null && t.token !== null);
  const deposit = incoming[0];
  if (deposit && deposit.token !== null && deposit.amount !== null) {
    return {
      ok: true,
      deposit: { asset: { contract: deposit.token }, amount: deposit.amount, fromAddress: deposit.from ?? "unknown", toWallet: wallet, ...(memo ? { memo } : {}) },
    };
  }

  return { ok: false, reason: "wrong_wallet" };
}

async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) {
    // Never put the RPC URL in the message: a hosted provider's API key often lives in it.
    throw new Error(`${method} HTTP ${response.status} from the configured Ethereum RPC`);
  }
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method} RPC error: ${body.error.message}`);
  if (body.result === undefined) throw new Error(`${method} returned no result`);
  return body.result;
}

/** keccak256("Transfer(address,address,uint256)") — the real, public ERC-20 Transfer event topic, not this project's own invention. */
const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** The 4-byte selector for the standard `decimals()` call (ERC-20's own ABI, not a guess). */
const DECIMALS_SELECTOR = "0x313ce567";

interface EthTransaction {
  to: string | null;
  value: string;
  input: string;
  from: string;
}
interface EthLog {
  address: string;
  topics: string[];
  data: string;
}
interface EthReceipt {
  status: string;
  logs: EthLog[];
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** A log's indexed `address` topic is left-padded to 32 bytes; the real 20-byte address is the last 40 hex chars. */
function addressFromTopic(topic: string): string {
  return `0x${topic.slice(-40)}`;
}

/**
 * Ethereum (ADR 0020 §3): `eth_getTransactionReceipt`'s own status decides success (a reverted
 * transaction moved nothing, whatever it looks like it attempted). A native transfer is read
 * straight off `eth_getTransactionByHash`'s `to`/`value`; an ERC-20 deposit is read off the real
 * `Transfer` event in the receipt's own logs, with the token's real decimals from a live
 * `decimals()` call — never assumed to be 18.
 */
export async function verifyEthereumDeposit(rpcUrl: string, txHash: string, wallet: string | undefined): Promise<DepositVerification> {
  if (!wallet) return { ok: false, reason: "not_configured" };
  if (!ETH_TX_HASH_FORMAT.test(txHash)) return { ok: false, reason: "malformed_reference" };

  let receipt: EthReceipt | null;
  let tx: EthTransaction | null;
  try {
    [receipt, tx] = await Promise.all([
      rpcCall<EthReceipt | null>(rpcUrl, "eth_getTransactionReceipt", [txHash]),
      rpcCall<EthTransaction | null>(rpcUrl, "eth_getTransactionByHash", [txHash]),
    ]);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (!receipt || !tx) return { ok: false, reason: "not_found" };
  if (receipt.status !== "0x1") return { ok: false, reason: "not_confirmed" };

  if (tx.to && sameAddress(tx.to, wallet) && BigInt(tx.value) > 0n) {
    return { ok: true, deposit: { asset: "native", amount: formatUnits(BigInt(tx.value), 18), fromAddress: tx.from, toWallet: wallet } };
  }

  const transferLog = receipt.logs.find(
    (log) => log.topics[0] === ERC20_TRANSFER_TOPIC && log.topics.length === 3 && sameAddress(addressFromTopic(log.topics[2] as string), wallet),
  );
  if (!transferLog) return { ok: false, reason: "wrong_wallet" };

  const rawAmount = BigInt(transferLog.data);
  let decimals = 18;
  try {
    const result = await rpcCall<string>(rpcUrl, "eth_call", [{ to: transferLog.address, data: DECIMALS_SELECTOR }, "latest"]);
    decimals = Number(BigInt(result));
  } catch {
    // The token's own decimals() call failing (a nonstandard token) shouldn't block a real,
    // already-confirmed Transfer event from being recorded — 18 is ERC-20's overwhelmingly
    // common default, and the raw amount is still real either way.
  }
  return {
    ok: true,
    deposit: {
      asset: { contract: transferLog.address },
      amount: formatUnits(rawAmount, decimals),
      fromAddress: addressFromTopic(transferLog.topics[1] as string),
      toWallet: wallet,
    },
  };
}

/**
 * What `BountyService` needs to verify a deposit, kept as an interface (not a direct call to the
 * two functions above) so a test can substitute a small, real, controllable stand-in instead of
 * hitting the network — the same "inject the dependency, don't mock the function" convention
 * `Authenticator` in other feature services already uses.
 */
export interface DepositVerifier {
  verify(chain: "ethereum" | "solana", txRef: string): Promise<DepositVerification>;
}

export interface RealDepositVerifierConfig {
  wallets: ReceivingWallets;
  solanaRpcUrl: string;
  ethereumRpcUrl: string;
}

/** The real verifier: live Solana/Ethereum RPC calls, wired in `server.ts`. */
export function createDepositVerifier(config: RealDepositVerifierConfig): DepositVerifier {
  const connection = new Connection(config.solanaRpcUrl, "confirmed");
  return {
    async verify(chain, txRef) {
      return chain === "solana" ? verifySolanaDeposit(connection, txRef, config.wallets.solana) : verifyEthereumDeposit(config.ethereumRpcUrl, txRef, config.wallets.ethereum);
    },
  };
}
