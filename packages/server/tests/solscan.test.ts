import { describe, expect, it } from "vitest";
import { normalizeSolscanTransfer } from "../src/chain/solscan.ts";
import { SolanaRpcProvider } from "../src/chain/solana.ts";
import { budgetMs } from "../src/lib/http.ts";

const WALLET = "Gs5FHwYLrDBmCmiv5VhBLCvyiBmBYfcPedZDqR88GYeX";
const SPL_SENDER = "FKqEzyT8LaHY9F1FkXZV4VTdM24c9J1rwcfjFNNWWTEJ";
const PUMP_MINT = "721co7BJpcwRsiDmPeXwaACM5sY7RmPzuakNHrnbpump";
// Confirmed against Solscan's real API: native SOL comes back under this placeholder, not the real
// wrapped-SOL mint (which ends ...112).
const SOLSCAN_NATIVE_PLACEHOLDER = "So11111111111111111111111111111111111111111";

describe("normalizeSolscanTransfer (real shape, confirmed against the live API)", () => {
  it("an SPL transfer maps 1:1 onto RawTransfer, same contract the RPC path promises", () => {
    const out = normalizeSolscanTransfer(
      {
        trans_id: "4PAMm95cGxBQT5QkLvSxwPoBSsaBWY9RruFEnmjTfZd7JjRwbaKUdTYYKFQivDvLeURvfSNNCfF9L2azYV7WNkMP",
        block_id: 460407929,
        block_time: 1792751083,
        activity_type: "ACTIVITY_SPL_TRANSFER",
        from_address: SPL_SENDER,
        to_address: WALLET,
        token_address: PUMP_MINT,
        token_decimals: 6,
        amount: 2832943659601,
        flow: "in",
      },
      0,
    );
    expect(out).toMatchObject({
      chain: "solana",
      txHash: "4PAMm95cGxBQT5QkLvSxwPoBSsaBWY9RruFEnmjTfZd7JjRwbaKUdTYYKFQivDvLeURvfSNNCfF9L2azYV7WNkMP",
      from: SPL_SENDER,
      to: WALLET,
      tokenId: PUMP_MINT,
      tokenDecimals: 6,
      tokenStandard: "spl",
      amountRaw: "2832943659601",
      priceCoin: `solana:${PUMP_MINT}`,
    });
  });

  it("the native-SOL placeholder mint normalizes to tokenId 'native', not a real SPL token", () => {
    const out = normalizeSolscanTransfer(
      {
        trans_id: "sig1",
        block_id: 1,
        block_time: 100,
        activity_type: "ACTIVITY_SPL_TRANSFER",
        from_address: "a",
        to_address: "b",
        token_address: SOLSCAN_NATIVE_PLACEHOLDER,
        token_decimals: 9,
        amount: 54336,
        flow: "in",
      },
      0,
    );
    expect(out).toMatchObject({ tokenId: "native", tokenSymbol: "SOL", tokenStandard: "native", priceCoin: "coingecko:solana" });
  });

  it("drops a row with no usable amount rather than guessing", () => {
    const out = normalizeSolscanTransfer(
      { trans_id: "x", block_id: 1, block_time: 1, activity_type: "ACTIVITY_SPL_TRANSFER", from_address: "a", to_address: "b", token_address: "m", token_decimals: 6, amount: "not-a-number", flow: "in" },
      0,
    );
    expect(out).toBeNull();
  });

  it("ordinal disambiguates two rows from the same transaction", () => {
    const row = { trans_id: "same-sig", block_id: 1, block_time: 1, activity_type: "ACTIVITY_SPL_TRANSFER", from_address: "a", to_address: "b", token_address: "m", token_decimals: 6, amount: 1, flow: "in" as const };
    expect(normalizeSolscanTransfer(row, 0)!.id).toBe("same-sig_0");
    expect(normalizeSolscanTransfer(row, 1)!.id).toBe("same-sig_1");
  });
});

describe("SolanaRpcProvider: Solscan used only when a signed-in caller's budget asks for it", () => {
  const solscanResponse = (rows: unknown[]) => new Response(JSON.stringify({ success: true, data: rows }));

  it("preferIndexed + solscanApiKey + no cursor -> calls Solscan, not getSignaturesForAddress", async () => {
    let calledSolscan = false;
    let calledRpc = false;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("pro-api.solscan.io")) {
        calledSolscan = true;
        expect((init?.headers as Record<string, string>).token).toBe("test-key");
        return solscanResponse([]);
      }
      calledRpc = true;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }));
    }) as typeof fetch;
    const provider = new SolanaRpcProvider("https://api.mainnet-beta.solana.com", false, fetchImpl, { solscanApiKey: "test-key" });
    const budget = budgetMs(5000);
    budget.preferIndexed = true;
    await provider.fetchStreamPage(WALLET, "signatures", null, budget);
    expect(calledSolscan).toBe(true);
    expect(calledRpc).toBe(false);
  });

  it("no preferIndexed (anonymous caller) -> stays on the free RPC path even with a key configured", async () => {
    let calledSolscan = false;
    const fetchImpl = (async (url: string) => {
      if (typeof url === "string" && url.includes("pro-api.solscan.io")) calledSolscan = true;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }));
    }) as typeof fetch;
    const provider = new SolanaRpcProvider("https://api.mainnet-beta.solana.com", false, fetchImpl, { solscanApiKey: "test-key" });
    await provider.fetchStreamPage(WALLET, "signatures", null, budgetMs(5000)); // preferIndexed left unset
    expect(calledSolscan).toBe(false);
  });

  it("resuming a 'solscan:<page>' cursor stays on Solscan even without preferIndexed re-set", async () => {
    let solscanPage: string | null = null;
    const fetchImpl = (async (url: string) => {
      if (typeof url === "string" && url.includes("pro-api.solscan.io")) {
        solscanPage = new URL(url).searchParams.get("page");
        return solscanResponse([]);
      }
      throw new Error("should not hit RPC when resuming a solscan cursor");
    }) as typeof fetch;
    const provider = new SolanaRpcProvider("https://api.mainnet-beta.solana.com", false, fetchImpl, { solscanApiKey: "test-key" });
    await provider.fetchStreamPage(WALLET, "signatures", "solscan:3", budgetMs(5000));
    expect(solscanPage).toBe("3");
  });

  it("no solscanApiKey configured -> always the RPC path, regardless of preferIndexed", async () => {
    let calledSolscan = false;
    const fetchImpl = (async (url: string) => {
      if (typeof url === "string" && url.includes("pro-api.solscan.io")) calledSolscan = true;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }));
    }) as typeof fetch;
    const provider = new SolanaRpcProvider("https://api.mainnet-beta.solana.com", false, fetchImpl, {});
    const budget = budgetMs(5000);
    budget.preferIndexed = true;
    await provider.fetchStreamPage(WALLET, "signatures", null, budget);
    expect(calledSolscan).toBe(false);
  });
});
