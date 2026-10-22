/**
 * Wallet-connect + message-signing only (used for wallet sign-in, AccountPanel.tsx) -- deliberately
 * split out from wallets.ts, which also pulls in @solana/web3.js + @solana/spl-token for real
 * on-chain sends. AccountPanel is mounted in the header on every page, never lazy; wallets.ts's
 * heavy chain SDKs must stay confined to DepositPanel's own lazy chunk (ADR -- see DepositPanel.tsx's
 * own lazy-import comment), so this file imports nothing beyond the two injected wallet providers.
 */

export type Chain = "ethereum" | "solana";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
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

/** EIP-191 `personal_sign` -- returns a hex signature, exactly what `ethers.verifyMessage` expects server-side. */
export async function signEthereumMessage(provider: EthereumProvider, address: string, message: string): Promise<string> {
  return (await provider.request({ method: "personal_sign", params: [message, address] })) as string;
}

// --- Solana (the de facto injected provider most wallets expose for compatibility) ---------

export interface SolanaProvider {
  connect(): Promise<{ publicKey: { toString(): string } }>;
  /** Phantom's standard message-signing method. Not every wallet exposes it. */
  signMessage?(message: Uint8Array, display?: string): Promise<{ signature: Uint8Array }>;
}

export function getSolanaProvider(): SolanaProvider | null {
  return (window as unknown as { solana?: SolanaProvider }).solana ?? null;
}

export async function connectSolana(provider: SolanaProvider): Promise<string> {
  const { publicKey } = await provider.connect();
  return publicKey.toString();
}

/** Returns a base64 signature, matching what the server's tweetnacl verify expects. */
export async function signSolanaMessage(provider: SolanaProvider, message: string): Promise<string> {
  if (!provider.signMessage) throw new Error("this wallet doesn't support message signing");
  const { signature } = await provider.signMessage(new TextEncoder().encode(message), "utf8");
  return bytesToBase64(signature);
}
