// Real wallet-connect + on-chain deposits for a bounty's stated reward (ADR 0020). Nothing here
// is trusted: every signature/hash this panel submits is independently re-verified server-side
// via real RPC before it's recorded. This still isn't escrow -- see the ADR.
//
// Bitcoin is deposit-only and paste-a-txid-only (ADR 0020 addendum): there's no browser
// wallet-connect standard for it, so it appears in the paste form, the wallet list and the
// deposit list, never in "connect a wallet and send". It's handled with local types/icons here
// rather than by widening the shared Chain/ChainSelect/ChainIcon, which drive the app-wide
// address/chain picker where Bitcoin isn't a supported chain at all.
import { useCallback, useEffect, useState } from "react";
import { CHAIN_NAMES, NATIVE_SYMBOLS, type BountyDeposit, type BountyWallets, type Chain, type DepositChain } from "@osstrace/contract";
import { serverApiCall } from "./serverSession.ts";
import { Loading, Notice } from "./ui.tsx";
import { assetDescription, assetLabel, fundingTotals } from "./bountyBoard.ts";
import { ChainIcon, ChainSelect } from "./ChainSelect.tsx";
import {
  connectEthereum,
  connectSolana,
  getEthereumProvider,
  getSolanaProvider,
  sendEthereumNative,
  sendEthereumToken,
  sendSolanaNative,
  sendSolanaToken,
  evmNetworkChainId,
  switchEvmNetwork,
} from "./wallets.ts";

type Deposit = BountyDeposit;
type Wallets = BountyWallets;

const NATIVE_SYMBOL: Record<DepositChain, string> = { ...NATIVE_SYMBOLS, bitcoin: "BTC" };
const CHAIN_NAME: Record<DepositChain, string> = { ...CHAIN_NAMES, bitcoin: "Bitcoin" };
const TX_REF_PLACEHOLDER: Record<DepositChain, string> = {
  solana: "Transaction signature",
  ethereum: "Transaction hash (0x…)",
  bnb: "Transaction hash (0x…)",
  robinhood: "Transaction hash (0x…)",
  bitcoin: "Transaction ID (txid)",
  base: "Transaction hash (0x…)",
  arbitrum: "Transaction hash (0x…)",
  optimism: "Transaction hash (0x…)",
  zora: "Transaction hash (0x…)",
  lens: "Transaction hash (0x…)",
  story: "Transaction hash (0x…)",
  gnosis: "Transaction hash (0x…)",
  ronin: "Transaction hash (0x…)",
  rootstock: "Transaction hash (0x…)",
  zetachain: "Transaction hash (0x…)",
  mythos: "Transaction hash (0x…)",
  hyperliquid: "Transaction hash (0x…)",
};
/** Display/selection order everywhere in this panel. */
const DEPOSIT_CHAINS: readonly DepositChain[] = ["solana", "ethereum", "bnb", "robinhood", "base", "arbitrum", "optimism", "zora", "lens", "story", "gnosis", "ronin", "rootstock", "zetachain", "mythos", "hyperliquid", "bitcoin"];
/** The chains a connected browser wallet can send on: every deposit chain but Bitcoin (paste-only).
 *  Derived from DepositChain, so a chain that gains deposits must also say how it's sent here. */
type SendChain = Exclude<DepositChain, "bitcoin">;
const SEND_CHAINS: readonly SendChain[] = ["solana", "ethereum", "bnb", "robinhood", "base", "arbitrum", "optimism", "zora", "lens", "story", "gnosis", "ronin", "rootstock", "zetachain", "mythos", "hyperliquid"];
const TOKEN_STANDARD: Record<SendChain, string> = {
  solana: "SPL token",
  ethereum: "ERC-20 token",
  bnb: "BEP-20 token",
  robinhood: "ERC-20 token",
  base: "ERC-20 token",
  arbitrum: "ERC-20 token",
  optimism: "ERC-20 token",
  zora: "ERC-20 token",
  lens: "ERC-20 token",
  story: "ERC-20 token",
  gnosis: "ERC-20 token",
  ronin: "ERC-20 token",
  rootstock: "ERC-20 token",
  zetachain: "ERC-20 token",
  mythos: "ERC-20 token",
  hyperliquid: "ERC-20 token",
};

/** The shared icon for the two app-wide chains; a plain orange "₿" disc for Bitcoin -- an honest
 *  generic mark, not an attempt at the exact brand artwork. */
function DepositChainIcon({ chain, size = 14 }: { chain: DepositChain; size?: number }) {
  if (chain !== "bitcoin") return <ChainIcon chain={chain} size={size} />;
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.72) }}
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-[#F7931A] font-bold leading-none text-white"
    >
      ₿
    </span>
  );
}

function short(value: string, head = 6, tail = 4): string {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

export default function DepositPanel({ bountyId, signedIn }: { bountyId: string; signedIn: boolean }) {
  const [wallets, setWallets] = useState<Wallets | null>(null);
  const [deposits, setDeposits] = useState<Deposit[] | null>(null);
  const [showForm, setShowForm] = useState(false);

  const loadDeposits = useCallback(async () => {
    const res = await serverApiCall<{ deposits: Deposit[] }>(`/api/bounties/${bountyId}`);
    if (res.ok) setDeposits(res.body.deposits);
    // The bounty detail endpoint already embeds its deposits -- no separate deposits-only route.
  }, [bountyId]);

  useEffect(() => {
    void (async () => {
      const res = await serverApiCall<Wallets>("/api/bounties/wallets");
      if (res.ok) setWallets(res.body);
    })();
    void loadDeposits();
  }, [loadDeposits]);

  const configuredChains = wallets ? DEPOSIT_CHAINS.filter((c) => wallets[c]) : [];

  // Summed per asset, never across assets (ADR 0020) -- the same totals the board's list shows.
  const totals = fundingTotals(deposits ?? []);

  return (
    <section className="card overflow-hidden">
      <div className="card-header">
        <h2 className="text-[15px] font-medium text-ink">Funding</h2>
        {signedIn && wallets && configuredChains.length > 0 && (
          <button type="button" onClick={() => setShowForm((v) => !v)} className="btn-outline">
            {showForm ? "Close" : "Back this bounty"}
          </button>
        )}
      </div>

      <div className="space-y-3 px-4 py-3 text-sm">
        {wallets && configuredChains.length === 0 && (
          <Notice>No receiving wallet is configured for any chain yet — this bounty can't take on-chain deposits.</Notice>
        )}
        {wallets && configuredChains.length > 0 && (
          <div className="space-y-1.5 text-xs text-ink-faint">
            {configuredChains.map((chain) => (
              <div key={chain} className="flex items-center gap-2">
                <DepositChainIcon chain={chain} />
                Send to <span className="hash text-ink-dim">{wallets[chain]}</span>
              </div>
            ))}
          </div>
        )}

        {deposits === null ? (
          <Loading label="Loading deposits…" />
        ) : deposits.length === 0 ? (
          <p className="text-xs text-ink-faint">No deposits recorded yet. A deposit is additive to the opener's own reward claim, never a replacement for it.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {totals.map((t) => (
                <span key={t.key} title={`Verified on-chain: ${assetDescription(t.chain, t.asset)}`} className="chip border border-signal/35 bg-signal/10 text-signal">
                  <span className="num">{t.total}</span> {assetLabel(t.chain, t.asset)}
                </span>
              ))}
            </div>
            <ul className="divide-y divide-line">
              {deposits.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                  <div className="flex min-w-0 items-center gap-2">
                    <DepositChainIcon chain={d.chain} />
                    <span className="num text-ink">
                      {d.amount} {assetLabel(d.chain, d.asset)}
                    </span>
                    <span className="hash truncate text-ink-faint">from {short(d.fromAddress)}</span>
                  </div>
                  <div className="hash shrink-0 text-ink-faint">{new Date(d.recordedAt).toLocaleString()}</div>
                  {d.memo && <div className="w-full truncate text-ink-faint">memo: {d.memo}</div>}
                </li>
              ))}
            </ul>
          </>
        )}

        {!signedIn && <p className="text-xs text-ink-faint">Log in to back this bounty with a real deposit.</p>}
        {showForm && signedIn && wallets && <FundForm bountyId={bountyId} wallets={wallets} onRecorded={() => { setShowForm(false); void loadDeposits(); }} />}
      </div>
    </section>
  );
}

type AssetMode = "native" | "token";

function FundForm({ bountyId, wallets, onRecorded }: { bountyId: string; wallets: Wallets; onRecorded: () => void }) {
  // Bitcoin is paste-only; the rest can be sent from a connected browser wallet. BNB goes through
  // the same injected Ethereum wallet, moved onto BNB Smart Chain first (switchEvmNetwork).
  const configured = SEND_CHAINS.filter((c) => wallets[c]);
  const pasteConfigured = DEPOSIT_CHAINS.filter((c) => wallets[c]);
  const [chain, setChain] = useState<SendChain>(configured[0] ?? "solana");
  const [assetMode, setAssetMode] = useState<AssetMode>("native");
  const [contract, setContract] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState<"idle" | "connecting" | "sending" | "recording">("idle");
  const [error, setError] = useState<string | null>(null);

  const [pasteChain, setPasteChain] = useState<DepositChain>(pasteConfigured[0] ?? "solana");
  const [pasteRef, setPasteRef] = useState("");
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);

  async function record(forChain: SendChain, txRef: string): Promise<boolean> {
    setBusy("recording");
    const res = await serverApiCall(`/api/bounties/${bountyId}/deposits`, { method: "POST", body: { chain: forChain, txRef } });
    setBusy("idle");
    if (!res.ok) {
      setError(res.message);
      return false;
    }
    onRecorded();
    return true;
  }

  async function connectAndSend(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    const wallet = wallets[chain];
    if (!wallet) {
      setError(`no wallet is configured for ${chain}`);
      return;
    }
    try {
      if (chain === "solana") {
        const provider = getSolanaProvider();
        if (!provider) {
          setError("no Solana wallet extension found in this browser");
          return;
        }
        setBusy("connecting");
        const from = await connectSolana(provider);
        setBusy("sending");
        const result =
          assetMode === "native"
            ? await sendSolanaNative(provider, from, wallet, amount, memo || undefined)
            : await sendSolanaToken(provider, from, contract, wallet, amount, memo || undefined);
        await record("solana", result.txRef);
      } else {
        const provider = getEthereumProvider();
        if (!provider) {
          setError("no Ethereum-compatible wallet extension (MetaMask etc.) found in this browser");
          return;
        }
        setBusy("connecting");
        const from = await connectEthereum(provider);
        // Before reading decimals or sending: both happen on whatever network the wallet is on.
        await switchEvmNetwork(provider, chain);
        setBusy("sending");
        const result = assetMode === "native" ? await sendEthereumNative(provider, from, wallet, amount) : await sendEthereumToken(provider, from, contract, wallet, amount);
        await record(chain, result.txRef);
      }
    } catch (cause) {
      setBusy("idle");
      setError(cause instanceof Error ? cause.message : "the wallet refused or failed to send that transaction");
    }
  }

  async function submitPasted(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setPasteError(null);
    setPasteBusy(true);
    const res = await serverApiCall(`/api/bounties/${bountyId}/deposits`, { method: "POST", body: { chain: pasteChain, txRef: pasteRef.trim() } });
    setPasteBusy(false);
    if (!res.ok) {
      setPasteError(res.message);
      return;
    }
    setPasteRef("");
    onRecorded();
  }

  const sending = busy !== "idle";

  return (
    <div className="space-y-5 border-t border-line pt-4">
      {configured.length > 0 && (
        <form onSubmit={connectAndSend} className="space-y-3">
          <h3 className="text-sm font-medium text-ink">Connect a wallet and send</h3>
          <div className="flex flex-wrap items-center gap-2">
            <ChainSelect
              value={chain}
              chains={configured}
              onChange={(c) => {
                setChain(c);
                setAssetMode("native");
                setContract("");
              }}
              small
            />
            <select value={assetMode} onChange={(e) => setAssetMode(e.target.value as AssetMode)} className="ctl h-9 text-sm">
              <option value="native">{NATIVE_SYMBOL[chain]} (native)</option>
              <option value="token">{TOKEN_STANDARD[chain]}</option>
            </select>
          </div>
          {assetMode === "token" && (
            <input
              value={contract}
              onChange={(e) => setContract(e.target.value)}
              placeholder={chain === "solana" ? "Token mint address" : "Token contract address (0x…)"}
              required
              className="ctl hash w-full"
            />
          )}
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount" required inputMode="decimal" className="ctl w-full" />
          {chain === "solana" && (
            <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Memo (optional, shown as a cross-check — not required)" maxLength={200} className="ctl w-full" />
          )}
          {chain !== "solana" && chain !== "ethereum" && chain !== "bnb" && (
            <p className="text-xs text-ink-faint">
              Sent from your Ethereum wallet on {CHAIN_NAME[chain]} (chain id {evmNetworkChainId(chain)}) — it's asked to switch to that network, or add it, before anything is sent.
            </p>
          )}
          <p className="text-xs text-ink-faint">
            Your wallet shows the real amount and destination before you approve — review it there. The signature is sent here and independently re-checked on-chain before anything is recorded.
          </p>
          {error && <Notice tone="danger">{error}</Notice>}
          <button type="submit" disabled={sending} className="btn-accent">
            {busy === "connecting" ? "Connecting wallet…" : busy === "sending" ? "Waiting for the wallet…" : busy === "recording" ? "Recording…" : "Connect & send"}
          </button>
        </form>
      )}

      <form onSubmit={submitPasted} className={configured.length > 0 ? "space-y-3 border-t border-line pt-4" : "space-y-3"}>
        <h3 className="text-sm font-medium text-ink">Already sent it? Paste the reference</h3>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2">
            <DepositChainIcon chain={pasteChain} size={16} />
            <select aria-label="Payment chain" value={pasteChain} onChange={(e) => setPasteChain(e.target.value as DepositChain)} className="ctl h-9 text-sm">
              {pasteConfigured.map((c) => (
                <option key={c} value={c}>
                  {CHAIN_NAME[c]}
                </option>
              ))}
            </select>
          </div>
          <input
            value={pasteRef}
            onChange={(e) => setPasteRef(e.target.value)}
            placeholder={TX_REF_PLACEHOLDER[pasteChain]}
            required
            className="ctl hash min-w-0 flex-1"
          />
        </div>
        {pasteChain === "bitcoin" && (
          <p className="text-xs text-ink-faint">
            Bitcoin can't be sent from this page — send from any wallet or exchange, then paste the txid here once it has at least one confirmation. Unlike SOL/ETH/BNB, a Bitcoin payment isn't matched to your signed-in wallet.
          </p>
        )}
        {pasteError && <Notice tone="danger">{pasteError}</Notice>}
        <button type="submit" disabled={pasteBusy} className="btn-outline">
          {pasteBusy ? "Verifying…" : "Verify & record"}
        </button>
      </form>
    </div>
  );
}
