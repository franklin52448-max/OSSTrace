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
import type { EthereumProvider as BaseEthereumProvider, SolanaProvider as BaseSolanaProvider } from "./walletConnect.ts";

// Connect/sign-message live in walletConnect.ts (no chain-SDK imports, safe to use eagerly from
// the header's AccountPanel.tsx) -- re-exported here so DepositPanel.tsx's existing imports don't
// need to change, and this module just adds the real on-chain *sending* on top. getEthereumProvider
// / getSolanaProvider are redeclared below (not re-exported) so they return the richer provider
// shape -- including signAndSendTransaction -- that the send functions here need.
export { connectEthereum, connectSolana, signEthereumMessage, signSolanaMessage } from "./walletConnect.ts";

export type Chain = "ethereum" | "solana";

export interface WalletSendResult {
  txRef: string;
  fromAddress: string;
}

// Exact BigInt decimal parsing/summing lives in decimalAmount.ts (no chain-SDK imports, so the
// bounty board's list can use it without loading this module) -- re-exported for existing callers.
import { parseDecimalAmount } from "./decimalAmount.ts";
export { parseDecimalAmount, sumDecimalAmounts } from "./decimalAmount.ts";

// --- Ethereum (EIP-1193) -------------------------------------------------------------------

type EthereumProvider = BaseEthereumProvider;

export function getEthereumProvider(): EthereumProvider | null {
  return (window as unknown as { ethereum?: EthereumProvider }).ethereum ?? null;
}

/** keccak256("transfer(address,uint256)")'s first 4 bytes — the real, public ERC-20 selector (same one `deposits.ts` verifies against, via its own event topic). */
const ERC20_TRANSFER_SELECTOR = "a9059cbb";
/** keccak256("decimals()")'s first 4 bytes — same constant `deposits.ts` uses server-side. */
const DECIMALS_SELECTOR = "0x313ce567";

async function fetchErc20Decimals(provider: EthereumProvider, contract: string): Promise<number> {
  const result = (await provider.request({ method: "eth_call", params: [{ to: contract, data: DECIMALS_SELECTOR }, "latest"] })) as string;
  return Number(BigInt(result));
}

/**
 * EIP-3326/EIP-3085 parameters for each EVM chain a deposit can be sent on. One injected wallet
 * (MetaMask etc.) serves both, but it sends on whichever network it's currently set to -- a "BNB"
 * deposit sent while it's on Ethereum would land on Ethereum and never verify against BNB, and the
 * reverse. So the wallet is moved to the right network before anything is sent.
 */
const EVM_NETWORKS = {
  ethereum: { chainId: "0x1", chainName: "Ethereum" },
  bnb: {
    chainId: "0x38",
    chainName: "BNB Smart Chain",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: ["https://bsc-dataseed.bnbchain.org"],
    blockExplorerUrls: ["https://bscscan.com"],
  },
  // Chain id 4663. Its native currency is ETH, so a wallet on the wrong one of these two shows the
  // very same "ETH" balance and symbol -- nothing on the wallet's own screen would flag the mix-up,
  // which is why the chain id check below is the guard, not the user's eye.
  robinhood: {
    chainId: "0x1237",
    chainName: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
    blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
  },
  // Chain id 8453 -- the same ETH-native trap as Robinhood Chain's, with Base's own official RPC and
  // explorer for a wallet that has to add it first.
  base: {
    chainId: "0x2105",
    chainName: "Base",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://mainnet.base.org"],
    blockExplorerUrls: ["https://basescan.org"],
  },
} as const;

const onNetwork = async (provider: EthereumProvider, chainId: string) => BigInt((await provider.request({ method: "eth_chainId" })) as string) === BigInt(chainId);

/** Puts the wallet on `chain`'s network (asking it to add BNB Smart Chain first if it doesn't know
 *  it -- error 4902), and refuses to continue unless it really is there afterwards. */
export async function switchEvmNetwork(provider: EthereumProvider, chain: keyof typeof EVM_NETWORKS): Promise<void> {
  const net = EVM_NETWORKS[chain];
  if (await onNetwork(provider, net.chainId)) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: net.chainId }] });
  } catch (cause) {
    const code = (cause as { code?: unknown } | null)?.code;
    if (code !== 4902 || !("rpcUrls" in net)) throw cause;
    await provider.request({ method: "wallet_addEthereumChain", params: [net] });
  }
  if (!(await onNetwork(provider, net.chainId))) throw new Error(`your wallet is on a different network -- switch it to ${net.chainName} and try again`);
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

interface SolanaProvider extends BaseSolanaProvider {
  signAndSendTransaction(transaction: Transaction): Promise<{ signature: string }>;
}

export function getSolanaProvider(): SolanaProvider | null {
  return (window as unknown as { solana?: SolanaProvider }).solana ?? null;
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
