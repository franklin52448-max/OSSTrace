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

/**
 * EIP-6963 multi-provider discovery. With more than one Ethereum wallet extension installed, each
 * tries to set the single `window.ethereum` global; whichever wins that race is what
 * getEthereumProvider() returns, regardless of which wallet the visitor actually clicked -- the
 * exact bug this fixes (seen live: MetaMask logging "another Ethereum wallet extension also
 * setting the global Ethereum provider" with Phantom also installed). EIP-6963 providers announce
 * themselves individually instead, so a specific wallet can be targeted by its own rdns rather than
 * guessed from one shared global. Listening starts at module load (not on first use) because
 * announce events arrive asynchronously -- a wallet extension needs a moment to respond to the
 * request event, so discovery needs a head start before the visitor actually opens the connect
 * menu, not a listener attached the instant they click it.
 */
export interface EIP6963ProviderDetail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: EthereumProvider;
}

const eip6963Providers: EIP6963ProviderDetail[] = [];
const eip6963Listeners = new Set<() => void>();

if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", ((event: CustomEvent<EIP6963ProviderDetail>) => {
    const detail = event.detail;
    if (!detail || eip6963Providers.some((d) => d.info.uuid === detail.info.uuid)) return;
    eip6963Providers.push(detail);
    for (const listener of eip6963Listeners) listener();
  }) as EventListener);
  // window.Event explicitly, not the bare global: in a real browser they're the same constructor,
  // but a test environment with its own separate `window` (e.g. jsdom alongside Node's own global
  // Event class) needs the event built from the exact realm it's dispatched on, or dispatchEvent
  // rejects it as "not of type 'Event'".
  window.dispatchEvent(new window.Event("eip6963:requestProvider"));
}

/** Every EIP-6963-announced wallet seen so far (empty if none support it yet, e.g. an older extension version). */
export function getEip6963Providers(): readonly EIP6963ProviderDetail[] {
  return eip6963Providers;
}

/** Test-only: a real browser never "un-announces" a wallet, so there's nothing to reset outside
 *  tests -- but each test in a single file run shares this module instance (the same reason
 *  serverSignOut() exists to reset the session singleton between tests), so a test that announces
 *  its own fake providers needs to clear them afterward or they leak into every later test. */
export function __resetEip6963ProvidersForTests(): void {
  eip6963Providers.length = 0;
}

/**
 * For useSyncExternalStore: announcements arrive asynchronously after module load, so a component
 * that only reads getEip6963Providers() once at first render can miss a wallet that was installed
 * all along and just hadn't responded yet -- subscribing re-renders the instant it does.
 */
export function subscribeEip6963(listener: () => void): () => void {
  eip6963Listeners.add(listener);
  return () => eip6963Listeners.delete(listener);
}

/**
 * MetaMask specifically, by its EIP-6963 rdns. Falls back to the old window.ethereum heuristic only
 * when NO wallet has announced via EIP-6963 at all -- never when other wallets announced but not
 * MetaMask, since that would silently connect through whichever of those won window.ethereum
 * instead, the same bug this exists to fix.
 */
export function getMetaMaskProvider(): EthereumProvider | null {
  const metamask = eip6963Providers.find((d) => d.info.rdns === "io.metamask");
  if (metamask) return metamask.provider;
  if (eip6963Providers.length > 0) return null;
  return getEthereumProvider();
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
