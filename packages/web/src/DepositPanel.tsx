// Real wallet-connect + on-chain deposits for a bounty's stated reward (ADR 0020). Nothing here
// is trusted: every signature/hash this panel submits is independently re-verified server-side
// via real RPC before it's recorded. This still isn't escrow -- see the ADR.
import { useCallback, useEffect, useState } from "react";
import type { ChainId } from "@osstrace/core";
import { apiCall } from "./session.ts";
import { Loading, Notice } from "./ui.tsx";
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
  sumDecimalAmounts,
} from "./wallets.ts";

const BOUNTIES_URL = import.meta.env["VITE_BOUNTIES_URL"] ?? "http://localhost:5313";

type DepositAsset = "native" | { contract: string };
interface Deposit {
  id: string;
  chain: ChainId;
  asset: DepositAsset;
  amount: string;
  txRef: string;
  fromAddress: string;
  recordedAt: string;
  toWallet: string;
  memo?: string;
}
type Wallets = { ethereum?: string; solana?: string };

const NATIVE_SYMBOL: Record<ChainId, string> = { ethereum: "ETH", solana: "SOL" };

function short(value: string, head = 6, tail = 4): string {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

function assetLabel(chain: ChainId, asset: DepositAsset): string {
  return asset === "native" ? NATIVE_SYMBOL[chain] : short(asset.contract, 6, 4);
}

function assetKey(chain: ChainId, asset: DepositAsset): string {
  return `${chain}:${asset === "native" ? "native" : asset.contract}`;
}

export default function DepositPanel({ bountyId, token }: { bountyId: string; token: string | null }) {
  const [wallets, setWallets] = useState<Wallets | null>(null);
  const [deposits, setDeposits] = useState<Deposit[] | null>(null);
  const [showForm, setShowForm] = useState(false);

  const loadDeposits = useCallback(async () => {
    const res = await apiCall<{ deposits: Deposit[] }>(`${BOUNTIES_URL}/bounties/${bountyId}/deposits`);
    if (res.ok) setDeposits(res.body.deposits);
  }, [bountyId]);

  useEffect(() => {
    void (async () => {
      const res = await apiCall<{ wallets: Wallets }>(`${BOUNTIES_URL}/bounties/wallets`);
      if (res.ok) setWallets(res.body.wallets);
    })();
    void loadDeposits();
  }, [loadDeposits]);

  const configuredChains = wallets ? (Object.keys(wallets) as ChainId[]).filter((c) => wallets[c]) : [];

  const totals = new Map<string, { chain: ChainId; asset: DepositAsset; amounts: string[] }>();
  for (const d of deposits ?? []) {
    const key = assetKey(d.chain, d.asset);
    const entry = totals.get(key) ?? { chain: d.chain, asset: d.asset, amounts: [] };
    entry.amounts.push(d.amount);
    totals.set(key, entry);
  }

  return (
    <section className="card overflow-hidden">
      <div className="card-header">
        <h2 className="text-[15px] font-medium text-ink">Funding</h2>
        {token && wallets && configuredChains.length > 0 && (
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
                <ChainIcon chain={chain} size={14} />
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
              {[...totals.values()].map((t) => (
                <span key={assetKey(t.chain, t.asset)} className="chip border border-signal/35 bg-signal/10 text-signal">
                  <span className="num">{sumDecimalAmounts(t.amounts)}</span> {assetLabel(t.chain, t.asset)}
                </span>
              ))}
            </div>
            <ul className="divide-y divide-line">
              {deposits.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                  <div className="flex min-w-0 items-center gap-2">
                    <ChainIcon chain={d.chain} size={14} />
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

        {!token && <p className="text-xs text-ink-faint">Log in to back this bounty with a real deposit.</p>}
        {showForm && token && wallets && <FundForm bountyId={bountyId} token={token} wallets={wallets} onRecorded={() => { setShowForm(false); void loadDeposits(); }} />}
      </div>
    </section>
  );
}

type AssetMode = "native" | "token";

function FundForm({ bountyId, token, wallets, onRecorded }: { bountyId: string; token: string; wallets: Wallets; onRecorded: () => void }) {
  const configured = (["solana", "ethereum"] as const).filter((c) => wallets[c]);
  const [chain, setChain] = useState<ChainId>(configured[0] ?? "solana");
  const [assetMode, setAssetMode] = useState<AssetMode>("native");
  const [contract, setContract] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState<"idle" | "connecting" | "sending" | "recording">("idle");
  const [error, setError] = useState<string | null>(null);

  const [pasteChain, setPasteChain] = useState<ChainId>(configured[0] ?? "solana");
  const [pasteRef, setPasteRef] = useState("");
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);

  async function record(forChain: ChainId, txRef: string): Promise<boolean> {
    setBusy("recording");
    const res = await apiCall(`${BOUNTIES_URL}/bounties/${bountyId}/deposits`, { method: "POST", token, body: { chain: forChain, txRef } });
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
          setError("no Ethereum wallet extension found in this browser");
          return;
        }
        setBusy("connecting");
        const from = await connectEthereum(provider);
        setBusy("sending");
        const result = assetMode === "native" ? await sendEthereumNative(provider, from, wallet, amount) : await sendEthereumToken(provider, from, contract, wallet, amount);
        await record("ethereum", result.txRef);
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
    const res = await apiCall(`${BOUNTIES_URL}/bounties/${bountyId}/deposits`, { method: "POST", token, body: { chain: pasteChain, txRef: pasteRef.trim() } });
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
      <form onSubmit={connectAndSend} className="space-y-3">
        <h3 className="text-sm font-medium text-ink">Connect a wallet and send</h3>
        <div className="flex flex-wrap items-center gap-2">
          <ChainSelect
            value={chain}
            onChange={(c) => {
              setChain(c);
              setAssetMode("native");
              setContract("");
            }}
            small
          />
          <select value={assetMode} onChange={(e) => setAssetMode(e.target.value as AssetMode)} className="ctl h-9 text-sm">
            <option value="native">{NATIVE_SYMBOL[chain]} (native)</option>
            <option value="token">{chain === "solana" ? "SPL token" : "ERC-20 token"}</option>
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
        <p className="text-xs text-ink-faint">
          Your wallet shows the real amount and destination before you approve — review it there. The signature is sent here and independently re-checked on-chain before anything is recorded.
        </p>
        {error && <Notice tone="danger">{error}</Notice>}
        <button type="submit" disabled={sending} className="btn-accent">
          {busy === "connecting" ? "Connecting wallet…" : busy === "sending" ? "Waiting for the wallet…" : busy === "recording" ? "Recording…" : "Connect & send"}
        </button>
      </form>

      <form onSubmit={submitPasted} className="space-y-3 border-t border-line pt-4">
        <h3 className="text-sm font-medium text-ink">Already sent it? Paste the reference</h3>
        <div className="flex flex-wrap items-center gap-2">
          <ChainSelect value={pasteChain} onChange={setPasteChain} small />
          <input
            value={pasteRef}
            onChange={(e) => setPasteRef(e.target.value)}
            placeholder={pasteChain === "solana" ? "Transaction signature" : "Transaction hash (0x…)"}
            required
            className="ctl hash min-w-0 flex-1"
          />
        </div>
        {pasteError && <Notice tone="danger">{pasteError}</Notice>}
        <button type="submit" disabled={pasteBusy} className="btn-outline">
          {pasteBusy ? "Verifying…" : "Verify & record"}
        </button>
      </form>
    </div>
  );
}
