// Plain-function + real-logic tests for src/wallets.ts (ADR 0020's frontend half). No jsdom is
// needed for most of this -- but the module reads `import.meta.env` at load time, so the Oxc
// loader hook in harness/env.ts (which shims it from process.env) has to be registered before it
// is ever imported; harness/env.ts does that as its own side effect.
import "./harness/env.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Keypair, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";

// Any real 32-byte base58-encoded value works as a stand-in blockhash -- it's never verified
// against anything by this module (that's `getLatestBlockhash`'s job on the real RPC); this just
// has to be a decodable Hash the same shape as a real one.
const STAND_IN_BLOCKHASH = Keypair.generate().publicKey.toBase58();

// `wallets.ts` reads `VITE_SOLANA_RPC_URL` once, at module-load time -- each Solana test needs its
// own fresh module instance so it picks up the stand-in URL `withSolanaRpcStandIn` just set,
// rather than reusing whatever the first-ever import captured (same `?case=` convention
// `session.test.ts` uses for the same reason; the template form keeps tsc from trying to resolve
// a literal path that doesn't exist on disk).
let loadCount = 0;
function freshWallets(): Promise<typeof import("../src/wallets.ts")> {
  return import(`../src/wallets.ts?case=${++loadCount}`);
}

function fixture(name: string): { result: { value: unknown } } {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"));
}
const USDC_MINT_ACCOUNT = fixture("solana-usdc-mint.json");

async function withSolanaRpcStandIn(routes: { getAccountInfo?: (address: string) => unknown }, run: (rpcUrl: string) => Promise<void>): Promise<void> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { method: string; params: unknown[]; id: number };
      let result: unknown = null;
      if (body.method === "getLatestBlockhash") {
        result = { context: { slot: 1 }, value: { blockhash: STAND_IN_BLOCKHASH, lastValidBlockHeight: 1 } };
      } else if (body.method === "getAccountInfo") {
        result = { context: { slot: 1 }, value: routes.getAccountInfo?.(body.params[0] as string) ?? null };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env["VITE_SOLANA_RPC_URL"] = `http://127.0.0.1:${port}`;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    delete process.env["VITE_SOLANA_RPC_URL"];
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A real, concrete stand-in for a Solana wallet's injected provider -- not a mocking framework. It really signs with a real (throwaway) keypair, so `signAndSendTransaction`'s input is exactly the Transaction this module built. */
class FakeSolanaProvider {
  readonly keypair = Keypair.generate();
  sent: Transaction[] = [];
  async connect() {
    return { publicKey: this.keypair.publicKey };
  }
  async signAndSendTransaction(transaction: Transaction) {
    this.sent.push(transaction);
    transaction.sign(this.keypair);
    return { signature: transaction.signature ? Buffer.from(transaction.signature).toString("hex") : "no-signature" };
  }
}

/** A real, concrete stand-in for window.ethereum (EIP-1193) -- records every call, answers what the test preprograms. */
class FakeEthereumProvider {
  readonly calls: { method: string; params?: unknown[] }[] = [];
  readonly answers = new Map<string, unknown>();
  answer(method: string, value: unknown): void {
    this.answers.set(method, value);
  }
  async request(args: { method: string; params?: unknown[] }): Promise<unknown> {
    this.calls.push(args);
    if (!this.answers.has(args.method)) throw new Error(`FakeEthereumProvider: no answer set for ${args.method}`);
    return this.answers.get(args.method);
  }
}

test("parseDecimalAmount: converts a human decimal string to its exact raw integer, no floating point", async () => {
  const { parseDecimalAmount } = await import("../src/wallets.ts");
  assert.equal(parseDecimalAmount("1", 9).toString(), "1000000000");
  assert.equal(parseDecimalAmount("0.0001", 9).toString(), "100000");
  assert.equal(parseDecimalAmount("1001", 6).toString(), "1001000000");
  assert.equal(parseDecimalAmount("0.1", 18).toString(), "100000000000000000"); // exact -- 0.1 isn't exactly representable as a float
});

test("parseDecimalAmount: refuses a negative amount, too many decimal places, or garbage", async () => {
  const { parseDecimalAmount } = await import("../src/wallets.ts");
  assert.throws(() => parseDecimalAmount("-1", 9));
  assert.throws(() => parseDecimalAmount("1.0000000001", 9)); // 10 places against a 9-decimal asset
  assert.throws(() => parseDecimalAmount("not a number", 9));
  assert.throws(() => parseDecimalAmount("", 9));
});

test("sumDecimalAmounts: adds already-formatted decimal strings exactly, inferring decimals from the widest input", async () => {
  const { sumDecimalAmounts } = await import("../src/wallets.ts");
  assert.equal(sumDecimalAmounts(["0.0001", "0.0002"]), "0.0003");
  assert.equal(sumDecimalAmounts(["1001", "0.5"]), "1001.5");
  assert.equal(sumDecimalAmounts(["5"]), "5");
  assert.equal(sumDecimalAmounts([]), "0");
});

test("sendEthereumNative: builds a plain value transfer with the exact wei amount, no data field", async () => {
  const { sendEthereumNative } = await import("../src/wallets.ts");
  const provider = new FakeEthereumProvider();
  provider.answer("eth_sendTransaction", "0xabc123");
  const result = await sendEthereumNative(provider, "0xFrom00000000000000000000000000000000001", "0xTo000000000000000000000000000000000002", "0.05");
  assert.equal(result.txRef, "0xabc123");
  assert.equal(result.fromAddress, "0xFrom00000000000000000000000000000000001");
  const call = provider.calls.find((c) => c.method === "eth_sendTransaction");
  const tx = call?.params?.[0] as { from: string; to: string; value: string };
  assert.equal(tx.from, "0xFrom00000000000000000000000000000000001");
  assert.equal(tx.to, "0xTo000000000000000000000000000000000002");
  assert.equal(BigInt(tx.value), 50000000000000000n); // 0.05 ETH in wei, exactly
});

test("sendEthereumToken: fetches the real token's decimals first, then builds a correctly ABI-encoded transfer() call", async () => {
  const { sendEthereumToken } = await import("../src/wallets.ts");
  const provider = new FakeEthereumProvider();
  provider.answer("eth_call", `0x${(6).toString(16).padStart(64, "0")}`); // decimals() -> 6
  provider.answer("eth_sendTransaction", "0xdef456");
  const to = "0x2198f7b79deafa4569bb98cb18e09ad18373f30d"; // a real address used elsewhere in this session's fixtures
  const result = await sendEthereumToken(provider, "0xFrom00000000000000000000000000000000001", "0xTokenContract000000000000000000000000001", to, "1.5");
  assert.equal(result.txRef, "0xdef456");
  const sendCall = provider.calls.find((c) => c.method === "eth_sendTransaction");
  const tx = sendCall?.params?.[0] as { from: string; to: string; data: string };
  assert.equal(tx.to, "0xTokenContract000000000000000000000000001"); // the token contract, not the recipient
  assert.equal(tx.data.slice(0, 10), "0xa9059cbb"); // the real ERC-20 transfer() selector
  assert.equal(tx.data.slice(10, 74), to.slice(2).toLowerCase().padStart(64, "0"));
  assert.equal(BigInt(`0x${tx.data.slice(74)}`), 1500000n); // 1.5 at 6 decimals, exactly
});

test("sendSolanaNative: builds a real SystemProgram transfer plus a real Memo instruction for the exact lamport amount", async () => {
  await withSolanaRpcStandIn({}, async () => {
    const { sendSolanaNative } = await freshWallets();
    const provider = new FakeSolanaProvider();
    const to = Keypair.generate().publicKey.toBase58();
    const result = await sendSolanaNative(provider, provider.keypair.publicKey.toBase58(), to, "0.0001", "bounty:abc123");
    assert.equal(result.fromAddress, provider.keypair.publicKey.toBase58());
    const sent = provider.sent[0]!;
    assert.equal(sent.instructions.length, 2);
    const transferIx = sent.instructions[0]!;
    assert.equal(transferIx.programId.toBase58(), SystemProgram.programId.toBase58()); // the real System Program
    const memoIx = sent.instructions[1]! as TransactionInstruction;
    assert.equal(memoIx.programId.toBase58(), "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
    assert.equal(memoIx.data.toString("utf8"), "bounty:abc123");
  });
});

test("sendSolanaNative: omits the memo instruction entirely when no memo is given -- never an empty one", async () => {
  await withSolanaRpcStandIn({}, async () => {
    const { sendSolanaNative } = await freshWallets();
    const provider = new FakeSolanaProvider();
    await sendSolanaNative(provider, provider.keypair.publicKey.toBase58(), Keypair.generate().publicKey.toBase58(), "1");
    assert.equal(provider.sent[0]!.instructions.length, 1);
  });
});

test("sendSolanaToken: creates the recipient's associated token account first when it doesn't exist yet, using the mint's real decimals", async () => {
  const to = Keypair.generate().publicKey;
  await withSolanaRpcStandIn(
    {
      getAccountInfo: (address) => {
        // The real USDC mint account for the mint lookup; null (doesn't exist) for every ATA --
        // this exercises the "create it first" branch.
        if (address === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") return USDC_MINT_ACCOUNT.result.value;
        return null;
      },
    },
    async () => {
      const { sendSolanaToken } = await freshWallets();
      const provider = new FakeSolanaProvider();
      const result = await sendSolanaToken(
        provider,
        provider.keypair.publicKey.toBase58(),
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        to.toBase58(),
        "1001",
      );
      assert.equal(result.fromAddress, provider.keypair.publicKey.toBase58());
      const sent = provider.sent[0]!;
      // create-ATA + transferChecked, no memo (none given).
      assert.equal(sent.instructions.length, 2);
      assert.equal(sent.instructions[1]!.programId.toBase58(), "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"); // the real Token program
    },
  );
});

test("sendSolanaToken: skips creating the associated token account when the recipient's already has one", async () => {
  const to = Keypair.generate().publicKey;
  await withSolanaRpcStandIn(
    {
      getAccountInfo: (address) => {
        if (address === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") return USDC_MINT_ACCOUNT.result.value;
        // Any other lookup (both ATAs) "exists" -- content is never decoded by this code path, only its presence is checked.
        return USDC_MINT_ACCOUNT.result.value;
      },
    },
    async () => {
      const { sendSolanaToken } = await freshWallets();
      const provider = new FakeSolanaProvider();
      await sendSolanaToken(provider, provider.keypair.publicKey.toBase58(), "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", to.toBase58(), "1001", "ref:1");
      const sent = provider.sent[0]!;
      // transferChecked + memo only -- no create-ATA instruction.
      assert.equal(sent.instructions.length, 2);
      assert.equal(sent.instructions[0]!.programId.toBase58(), "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
      assert.equal(sent.instructions[1]!.programId.toBase58(), "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
    },
  );
});
