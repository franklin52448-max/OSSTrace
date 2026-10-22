import { describe, expect, it } from "vitest";
import { normalizeSolanaTx, SolanaRpcProvider, touches, type SolTx } from "../src/chain/solana.ts";
import { budgetMs } from "../src/lib/http.ts";
import { fixture } from "./helpers.ts";

const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const USDT_ACCT = "TB5FCqbNsnuLQgEjUuPaT9qtVPTT4U1A8rvi7qzEj2M";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

describe("token-account-only transactions (recorded 2026-10-22)", () => {
  const t = fixture<SolTx>("solana/tx.token-account-only.json");

  it("the fixture really omits the owner wallet from accountKeys", () => {
    const keys = t.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
    expect(keys).not.toContain(WALLET);
    expect(keys).toContain(USDT_ACCT);
  });

  it("maps the destination token account to the owner wallet via postTokenBalances", () => {
    const out = normalizeSolanaTx(t);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ to: USDT_ACCT, toOwner: WALLET, tokenId: USDT, amountRaw: "1320000", tokenDecimals: 6, tokenStandard: "spl" });
    expect(touches(out[0]!, WALLET)).toBe(true);
  });
});

/** Fake RPC: wallet + one token account, each with its own signature list; sigs map to recorded txs. */
function fakeRpc(opts: { walletSigs: any[]; acctSigs: any[]; txs: Record<string, SolTx>; failAcctSigs?: boolean }) {
  const calls: { method: string; params: any[] }[] = [];
  const f = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ method: body.method, params: body.params });
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    if (body.method === "getTokenAccountsByOwner") {
      const isLegacy = body.params[1].programId.startsWith("Tokenkeg");
      return ok({ value: isLegacy ? [{ pubkey: USDT_ACCT, account: { data: { parsed: { info: { mint: USDT, tokenAmount: { amount: "5", decimals: 6 } } } } } }] : [] });
    }
    if (body.method === "getSignaturesForAddress") {
      const [addr, o] = body.params;
      if (addr === USDT_ACCT && opts.failAcctSigs) return new Response("{}", { status: 429, headers: { "retry-after": "60" } });
      const list = addr === WALLET ? opts.walletSigs : opts.acctSigs;
      const start = o.before ? list.findIndex((s: any) => s.signature === o.before) + 1 : 0;
      return ok(list.slice(start, start + o.limit));
    }
    if (body.method === "getTransaction") return ok(opts.txs[body.params[0]] ?? null);
    return ok(null);
  }) as unknown as typeof fetch;
  return { f, calls };
}

const sig = (signature: string, blockTime: number) => ({ signature, blockTime, slot: blockTime, err: null, confirmationStatus: "finalized", memo: null });

describe("SolanaRpcProvider merges wallet and token-account signatures", () => {
  const acctOnly = fixture<SolTx>("solana/tx.token-account-only.json");
  const walletTx = fixture<SolTx>("solana/tx.system-single.json");
  const walletSig = walletTx.transaction.signatures[0]!;
  const acctSig = acctOnly.transaction.signatures[0]!;
  const txs = { [walletSig]: walletTx, [acctSig]: acctOnly };

  it("before/after: wallet-only misses the incoming USDT transfer, token-account mode finds it", async () => {
    const data = { walletSigs: [sig(walletSig, walletTx.blockTime!)], acctSigs: [sig(acctSig, acctOnly.blockTime!)], txs };
    const before = new SolanaRpcProvider("https://rpc.test", false, fakeRpc(data).f, { maxTokenAccounts: 0 });
    const b = await before.fetchStreamPage(WALLET, "signatures", null, budgetMs(10_000));
    expect(b.transfers.filter((t) => t.toOwner === WALLET && t.tokenStandard === "spl")).toHaveLength(0);

    const { f, calls } = fakeRpc(data);
    const after = new SolanaRpcProvider("https://rpc.test", false, f);
    const a = await after.fetchStreamPage(WALLET, "signatures", null, budgetMs(10_000));
    const incoming = a.transfers.filter((t) => t.toOwner === WALLET && t.tokenStandard === "spl");
    expect(incoming).toHaveLength(1);
    expect(incoming[0]!.id).toBe(`${acctSig}_0`);
    expect(calls.filter((c) => c.method === "getTokenAccountsByOwner")).toHaveLength(2); // Token + Token-2022
    expect(a.nextCursor).toBeNull(); // both sources exhausted
    expect(a.oldestTime).toBe(Math.min(walletTx.blockTime!, acctOnly.blockTime!));
  });

  it("dedupes a signature seen by both sources and only processes above the merge frontier", async () => {
    // Wallet has 10 sigs (a full page => maybe more), token account shares the newest one and has an old one.
    const now = 1_800_000_000;
    const walletSigs = Array.from({ length: 10 }, (_, i) => sig(`w${i}`, now - i * 100));
    const acctSigs = [sig("w0", now), sig(acctSig, now - 5000)];
    const { f, calls } = fakeRpc({ walletSigs, acctSigs, txs: {} });
    const p = new SolanaRpcProvider("https://rpc.test", false, f);
    const page = await p.fetchStreamPage(WALLET, "signatures", null, budgetMs(10_000));
    const fetched = calls.filter((c) => c.method === "getTransaction").map((c) => c.params[0]);
    expect(fetched.filter((s) => s === "w0")).toHaveLength(1);
    // The wallet may have more signatures older than w9, so the old token-account sig waits for a later page.
    expect(fetched).not.toContain(acctSig);
    expect(page.oldestTime).toBe(now - 900);
    expect(page.nextCursor).not.toBeNull();
    // Next page: wallet is exhausted (no more sigs) -> the buffered token-account sig is processed.
    const page2 = await p.fetchStreamPage(WALLET, "signatures", page.nextCursor, budgetMs(10_000));
    expect(calls.filter((c) => c.method === "getTransaction").map((c) => c.params[0])).toContain(acctSig);
    expect(page2.nextCursor).toBeNull();
  });

  it("a token account that cannot be fetched is skipped with a note (partial), the wallet still loads", async () => {
    const { f } = fakeRpc({ walletSigs: [sig(walletSig, walletTx.blockTime!)], acctSigs: [], txs, failAcctSigs: true });
    const p = new SolanaRpcProvider("https://rpc.test", false, f);
    const page = await p.fetchStreamPage(WALLET, "signatures", null, budgetMs(3_000));
    expect(page.transfers.length).toBeGreaterThan(0);
    expect(page.note).toMatch(/token account TB5FCq… skipped/);
  });

  it("follows at most N token accounts and says so", async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ pubkey: `Acct${i}`.padEnd(43, "1"), account: { data: { parsed: { info: { mint: USDT, tokenAmount: { amount: "1", decimals: 6 } } } } } }));
    const f = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
      if (body.method === "getTokenAccountsByOwner") return ok({ value: body.params[1].programId.startsWith("Tokenkeg") ? many : [] });
      return ok([]);
    }) as unknown as typeof fetch;
    const p = new SolanaRpcProvider("https://rpc.test", false, f, { recentTokenAccounts: () => [many[5]!.pubkey] });
    const pick = await p.pickTokenAccounts(WALLET, budgetMs(3000));
    expect(pick.total).toBe(6);
    expect(pick.picked).toHaveLength(4);
    expect(pick.picked[0]).toBe(many[5]!.pubkey); // recently active first
    const page = await p.fetchStreamPage(WALLET, "signatures", null, budgetMs(3000));
    expect(page.note).toMatch(/4 of 6 token accounts/);
  });
});
