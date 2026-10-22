/**
 * Real wallet-connect and on-chain sending for bounty deposits (ADR 0020). Neither chain uses a
 * wallet-adapter framework: Ethereum talks directly to the standard injected EIP-1193 provider
 * (`window.ethereum`), and Solana talks directly to the same de facto provider most wallets
 * inject for compatibility (`window.solana`) — the same "no framework, talk to the real standard
 * directly" posture this project already takes for everything else it touches on-chain.
 *
 * Nothing here is trusted by the backend: `POST /bounties/:id/deposits` independently
 * re-verifies whatever signature/hash comes back via real RPC (`packages/features/bounties/src/deposits.ts`).
 * A bug here can send the wrong amount to the wrong place — the wallet's own confirmation screen
 * is the user's real safety net, same as any other dApp — but it can never fabricate a deposit
 * the server didn't itself check.
 */
import "./bufferPolyfill.ts";
import { Buffer } from "buffer";
import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  getMint,
} from "@solana/spl-token";

export type Chain = "ethereum" | "solana";

export interface WalletSendResult {
  txRef: string;
  fromAddress: string;
}

/**
 * A human-typed decimal amount ("0.05", "1001") parsed into its exact raw integer at a given
 * number of decimals — entirely in BigInt, never `Number`/floating point, so a deposit amount is
 * never silently rounded the way IEEE-754 would round e.g. 0.1 + 0.2. Mirrors the inverse of
 * `@osstrace/chain-ethereum`'s `formatUnits` on the read side.
 */
export function parseDecimalAmount(amountHuman: string, decimals: number): bigint {
  const trimmed = amountHuman.trim();
  if (trimmed.startsWith("-")) throw new Error("amount must not be negative");
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") throw new Error("not a valid amount");
  const [whole = "0", frac = ""] = trimmed.split(".");
  if (frac.length > decimals) throw new Error(`this asset only has ${decimals} decimal place${decimals === 1 ? "" : "s"}`);
  const digits = `${whole}${frac.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
  return BigInt(digits === "" ? "0" : digits);
}

// --- Ethereum (EIP-1193) -------------------------------------------------------------------

export interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export function getEthereumProvider(): EthereumProvider | null {
  return (window as unknown as { ethereum?: EthereumProvider }).ethereum ?? null;
}

export async function connectEthereum(provider: EthereumProvider): Promise<string> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const address = accounts[0];
  if (!address) throw new Error("the wallet returned no account");
  return address;
}

/** keccak256("transfer(address,uint256)")'s first 4 bytes — the real, public ERC-20 selector (same one `deposits.ts` verifies against, via its own event topic). */
const ERC20_TRANSFER_SELECTOR = "a9059cbb";
/** keccak256("decimals()")'s first 4 bytes — same constant `deposits.ts` uses server-side. */
const DECIMALS_SELECTOR = "0x313ce567";

async function fetchErc20Decimals(provider: EthereumProvider, contract: string): Promise<number> {
  const result = (await provider.request({ method: "eth_call", params: [{ to: contract, data: DECIMALS_SELECTOR }, "latest"] })) as string;
  return Number(BigInt(result));
}

export async function sendEthereumNative(provider: EthereumProvider, from: string, to: string, amountEth: string): Promise<WalletSendResult> {
  const value = `0x${parseDecimalAmount(amountEth, 18).toString(16)}`;
  const txRef = (await provider.request({ method: "eth_sendTransaction", params: [{ from, to, value }] })) as string;
  return { txRef, fromAddress: from };
}

export async function sendEthereumToken(provider: EthereumProvider, from: string, contract: string, to: string, amountHuman: string): Promise<WalletSendResult> {
  const decimals = await fetchErc20Decimals(provider, contract);
  const raw = parseDecimalAmount(amountHuman, decimals);
  const data = `0x${ERC20_TRANSFER_SELECTOR}${to.slice(2).toLowerCase().padStart(64, "0")}${raw.toString(16).padStart(64, "0")}`;
  const txRef = (await provider.request({ method: "eth_sendTransaction", params: [{ from, to: contract, data }] })) as string;
  return { txRef, fromAddress: from };
}

// --- Solana (the de facto injected provider most wallets expose for compatibility) ---------

export interface SolanaProvider {
  connect(): Promise<{ publicKey: { toString(): string } }>;
  signAndSendTransaction(transaction: Transaction): Promise<{ signature: string }>;
}

export function getSolanaProvider(): SolanaProvider | null {
  return (window as unknown as { solana?: SolanaProvider }).solana ?? null;
}

export async function connectSolana(provider: SolanaProvider): Promise<string> {
  const { publicKey } = await provider.connect();
  return publicKey.toString();
}

const SOLANA_RPC_URL: string = import.meta.env["VITE_SOLANA_RPC_URL"] ?? "https://api.mainnet-beta.solana.com";
/** The real, public SPL Memo program — same constant `deposits.ts` recognizes server-side. */
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

function memoInstruction(memo: string): TransactionInstruction {
  return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(memo, "utf8") });
}

async function withBlockhash(connection: Connection, transaction: Transaction, feePayer: PublicKey): Promise<Transaction> {
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = feePayer;
  return transaction;
}

export async function sendSolanaNative(provider: SolanaProvider, from: string, to: string, amountSol: string, memo?: string): Promise<WalletSendResult> {
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  const fromPubkey = new PublicKey(from);
  const lamports = parseDecimalAmount(amountSol, 9);
  const transaction = new Transaction().add(SystemProgram.transfer({ fromPubkey, toPubkey: new PublicKey(to), lamports }));
  if (memo) transaction.add(memoInstruction(memo));
  await withBlockhash(connection, transaction, fromPubkey);
  const { signature } = await provider.signAndSendTransaction(transaction);
  return { txRef: signature, fromAddress: from };
}

/**
 * SPL/Token-2022 deposit: creates the recipient's associated token account first if it doesn't
 * exist yet (paid by the sender, same as any wallet-to-wallet first transfer of a token) — real
 * decimals come from the mint itself (`getMint`), never assumed.
 */
export async function sendSolanaToken(
  provider: SolanaProvider,
  from: string,
  mint: string,
  to: string,
  amountHuman: string,
  memo?: string,
): Promise<WalletSendResult> {
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  const fromPubkey = new PublicKey(from);
  const mintPubkey = new PublicKey(mint);
  const toPubkey = new PublicKey(to);

  const mintInfo = await getMint(connection, mintPubkey);
  const amountRaw = parseDecimalAmount(amountHuman, mintInfo.decimals);

  const fromAta = await getAssociatedTokenAddress(mintPubkey, fromPubkey);
  const toAta = await getAssociatedTokenAddress(mintPubkey, toPubkey);
  const toAtaInfo = await connection.getAccountInfo(toAta);

  const transaction = new Transaction();
  if (!toAtaInfo) transaction.add(createAssociatedTokenAccountInstruction(fromPubkey, toAta, toPubkey, mintPubkey));
  transaction.add(createTransferCheckedInstruction(fromAta, mintPubkey, toAta, fromPubkey, amountRaw, mintInfo.decimals));
  if (memo) transaction.add(memoInstruction(memo));

  await withBlockhash(connection, transaction, fromPubkey);
  const { signature } = await provider.signAndSendTransaction(transaction);
  return { txRef: signature, fromAddress: from };
}

/**
 * Adds already-formatted decimal-string amounts (as `Deposit.amount` comes from the API) without
 * ever going through floating point — used only to show a per-asset running total on the board.
 * Decimals are inferred per call from however many fractional digits the real amounts carry.
 */
export function sumDecimalAmounts(amounts: string[]): string {
  const decimals = Math.max(0, ...amounts.map((a) => (a.split(".")[1] ?? "").length));
  const total = amounts.reduce((sum, a) => sum + parseDecimalAmount(a, decimals), 0n);
  const s = total.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals) || "0";
  const frac = decimals > 0 ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : whole;
}
