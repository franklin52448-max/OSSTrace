import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Connection } from "@solana/web3.js";
import { verifyEthereumDeposit, verifySolanaDeposit } from "../src/deposits.ts";

/**
 * Against real, unedited mainnet data (recorded 2026-10-22, raw JSON-RPC responses, served back
 * by a local stand-in server) — not invented transaction shapes. This is the code that decides
 * whether real money moved; a fabricated fixture would prove nothing about the real thing.
 */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"));
}

const SOLANA_NATIVE = fixture("solana-native-transfer.json") as { result: { transaction: { signatures: string[] } } };
const SOLANA_NATIVE_SIG = SOLANA_NATIVE.result.transaction.signatures[0] as string;
const SOLANA_NATIVE_WALLET = "vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg";
const SOLANA_NATIVE_FROM = "E16prLnWTwfLUYgXRTELYgw4u8QUnN9CAcHceLrDTjN1";

// Reused from @osstrace/chain-solana's own real fixture (a real Jupiter-routed swap) rather than
// recording a second copy of the same real transaction.
const SOLANA_SPL = fixture("../../../../chains/solana/tests/fixtures/raydium-v4-swap-transfer.json") as {
  result: { transaction: { signatures: string[] } };
};
const SOLANA_SPL_SIG = SOLANA_SPL.result.transaction.signatures[0] as string;
const SOLANA_SPL_WALLET = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const SOLANA_SPL_FROM = "6MtUE8BGGvThA9SvBP6jNoqzuV87G9yC4WsLRvVoS173";
const SOLANA_SPL_MINT = "8Lqgcs9hhbu49iwwFReDhNWQVJfnENpG4JGx9Afvpump";

async function withSolanaStandIn(responses: Map<string, unknown>, run: (connection: Connection) => Promise<void>): Promise<void> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { method: string; params: unknown[]; id: number };
      if (body.method === "getTransaction") {
        const signature = body.params[0] as string;
        const result = responses.get(signature);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: result ?? null }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(new Connection(`http://127.0.0.1:${port}`, "confirmed"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("verifySolanaDeposit: no wallet configured for this chain is refused before any RPC call", async () => {
  await withSolanaStandIn(new Map(), async (connection) => {
    const result = await verifySolanaDeposit(connection, SOLANA_NATIVE_SIG, undefined);
    assert.deepEqual(result, { ok: false, reason: "not_configured" });
  });
});

test("verifySolanaDeposit: not a real signature shape is refused before any RPC call", async () => {
  await withSolanaStandIn(new Map(), async (connection) => {
    const result = await verifySolanaDeposit(connection, "not-a-real-signature", SOLANA_NATIVE_WALLET);
    assert.deepEqual(result, { ok: false, reason: "malformed_reference" });
  });
});

test("verifySolanaDeposit: a real native SOL transfer to the configured wallet verifies with the real amount and sender", async () => {
  const responses = new Map([[SOLANA_NATIVE_SIG, (SOLANA_NATIVE as { result: unknown }).result]]);
  await withSolanaStandIn(responses, async (connection) => {
    const result = await verifySolanaDeposit(connection, SOLANA_NATIVE_SIG, SOLANA_NATIVE_WALLET);
    assert.deepEqual(result, {
      ok: true,
      deposit: { asset: "native", amount: "0.0001", fromAddress: SOLANA_NATIVE_FROM, toWallet: SOLANA_NATIVE_WALLET },
    });
  });
});

test("verifySolanaDeposit: the same real transaction against a different wallet is refused (it wasn't paid)", async () => {
  const responses = new Map([[SOLANA_NATIVE_SIG, (SOLANA_NATIVE as { result: unknown }).result]]);
  await withSolanaStandIn(responses, async (connection) => {
    const result = await verifySolanaDeposit(connection, SOLANA_NATIVE_SIG, "11111111111111111111111111111111111111112");
    assert.deepEqual(result, { ok: false, reason: "wrong_wallet" });
  });
});

test("verifySolanaDeposit: a real SPL token transfer (reused from chain-solana's own real swap fixture) verifies with the real mint, amount and owner", async () => {
  const responses = new Map([[SOLANA_SPL_SIG, (SOLANA_SPL as { result: unknown }).result]]);
  await withSolanaStandIn(responses, async (connection) => {
    const result = await verifySolanaDeposit(connection, SOLANA_SPL_SIG, SOLANA_SPL_WALLET);
    assert.deepEqual(result, {
      ok: true,
      deposit: { asset: { contract: SOLANA_SPL_MINT }, amount: "85437.459163", fromAddress: SOLANA_SPL_FROM, toWallet: SOLANA_SPL_WALLET },
    });
  });
});

// A real transferChecked carrying a real spl-memo instruction alongside it (recorded 2026-10-22) --
// the RPC's own jsonParsed encoding already decodes the memo to plain text, reused here rather
// than re-decoded from raw bytes.
const SOLANA_MEMO = fixture("solana-spl-transfer-with-memo.json") as { result: { transaction: { signatures: string[] } } };
const SOLANA_MEMO_SIG = SOLANA_MEMO.result.transaction.signatures[0] as string;
const SOLANA_MEMO_WALLET = "5JZdWrhdgNrbM89g7CUt6P7spzG8gERtXZTUXvVG9Gt2";
const SOLANA_MEMO_FROM = "4QULNSZE1vXV3RNd91zdEHGAS4d2YfRBxUYhsDhZFfdf";
const SOLANA_MEMO_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const SOLANA_MEMO_TEXT = "1792665409039722054";

test("verifySolanaDeposit: a real transaction carrying a real spl-memo instruction surfaces it as a cross-check, not required for correlation", async () => {
  const responses = new Map([[SOLANA_MEMO_SIG, (SOLANA_MEMO as { result: unknown }).result]]);
  await withSolanaStandIn(responses, async (connection) => {
    const result = await verifySolanaDeposit(connection, SOLANA_MEMO_SIG, SOLANA_MEMO_WALLET);
    assert.deepEqual(result, {
      ok: true,
      deposit: { asset: { contract: SOLANA_MEMO_MINT }, amount: "1001", fromAddress: SOLANA_MEMO_FROM, toWallet: SOLANA_MEMO_WALLET, memo: SOLANA_MEMO_TEXT },
    });
  });
});

test("verifySolanaDeposit: a real transaction with no memo instruction simply has no memo field -- never a null or empty placeholder", async () => {
  const responses = new Map([[SOLANA_NATIVE_SIG, (SOLANA_NATIVE as { result: unknown }).result]]);
  await withSolanaStandIn(responses, async (connection) => {
    const result = await verifySolanaDeposit(connection, SOLANA_NATIVE_SIG, SOLANA_NATIVE_WALLET);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal("memo" in result.deposit, false);
  });
});

test("verifySolanaDeposit: an unknown signature is not_found", async () => {
  await withSolanaStandIn(new Map(), async (connection) => {
    // A real-shaped but made-up signature: the stand-in server has nothing recorded for it.
    const unknown = "5".repeat(88);
    const result = await verifySolanaDeposit(connection, unknown, SOLANA_NATIVE_WALLET);
    assert.deepEqual(result, { ok: false, reason: "not_found" });
  });
});

test("verifySolanaDeposit: a failed transaction (meta.err set) is not_confirmed, even though it 'looks' like a transfer", async () => {
  const failed = structuredClone((SOLANA_NATIVE as { result: { meta: { err: unknown } } }).result);
  failed.meta.err = { InstructionError: [0, { Custom: 1 }] };
  const responses = new Map([[SOLANA_NATIVE_SIG, failed]]);
  await withSolanaStandIn(responses, async (connection) => {
    const result = await verifySolanaDeposit(connection, SOLANA_NATIVE_SIG, SOLANA_NATIVE_WALLET);
    assert.deepEqual(result, { ok: false, reason: "not_confirmed" });
  });
});

// --- Ethereum -----------------------------------------------------------------------------------

const ETH_NATIVE_RECEIPT = fixture("ethereum-native-receipt.json") as { result: { status: string } };
const ETH_NATIVE_TX = fixture("ethereum-native-tx.json") as { result: { hash: string; to: string; from: string; value: string } };
const ETH_NATIVE_HASH = ETH_NATIVE_TX.result.hash;
const ETH_NATIVE_WALLET = ETH_NATIVE_TX.result.to;
const ETH_NATIVE_FROM = ETH_NATIVE_TX.result.from;

const ETH_ERC20_RECEIPT = fixture("ethereum-erc20-receipt.json") as { result: { logs: { topics: string[]; address: string }[] } };
const ETH_ERC20_TX = fixture("ethereum-erc20-tx.json") as { result: { hash: string } };
const ETH_ERC20_HASH = ETH_ERC20_TX.result.hash;
// The real USDC Transfer log's `to` topic, left-padded to 32 bytes -- the real recipient this
// transaction paid, used here as the "configured wallet" under test.
const ETH_ERC20_WALLET = `0x${(ETH_ERC20_RECEIPT.result.logs[0] as { topics: string[] }).topics[2]!.slice(-40)}`;
const ETH_ERC20_FROM = `0x${(ETH_ERC20_RECEIPT.result.logs[0] as { topics: string[] }).topics[1]!.slice(-40)}`;
const ETH_ERC20_CONTRACT = (ETH_ERC20_RECEIPT.result.logs[0] as { address: string }).address;
const DECIMALS_SELECTOR = "0x313ce567";

async function withEthereumStandIn(
  routes: { receipt?: Map<string, unknown>; tx?: Map<string, unknown>; decimals?: number },
  run: (rpcUrl: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { method: string; params: unknown[]; id: number };
      let result: unknown = null;
      if (body.method === "eth_getTransactionReceipt") result = routes.receipt?.get(body.params[0] as string) ?? null;
      else if (body.method === "eth_getTransactionByHash") result = routes.tx?.get(body.params[0] as string) ?? null;
      else if (body.method === "eth_call" && (body.params[0] as { data: string }).data === DECIMALS_SELECTOR) {
        result = `0x${(routes.decimals ?? 18).toString(16).padStart(64, "0")}`;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("verifyEthereumDeposit: no wallet configured is refused before any RPC call", async () => {
  await withEthereumStandIn({}, async (rpcUrl) => {
    const result = await verifyEthereumDeposit(rpcUrl, ETH_NATIVE_HASH, undefined);
    assert.deepEqual(result, { ok: false, reason: "not_configured" });
  });
});

test("verifyEthereumDeposit: not a real tx-hash shape is refused before any RPC call", async () => {
  await withEthereumStandIn({}, async (rpcUrl) => {
    const result = await verifyEthereumDeposit(rpcUrl, "0xnope", ETH_NATIVE_WALLET);
    assert.deepEqual(result, { ok: false, reason: "malformed_reference" });
  });
});

test("verifyEthereumDeposit: a real native ETH transfer to the configured wallet verifies with the real amount and sender", async () => {
  const routes = {
    receipt: new Map([[ETH_NATIVE_HASH, ETH_NATIVE_RECEIPT.result]]),
    tx: new Map([[ETH_NATIVE_HASH, ETH_NATIVE_TX.result]]),
  };
  await withEthereumStandIn(routes, async (rpcUrl) => {
    const result = await verifyEthereumDeposit(rpcUrl, ETH_NATIVE_HASH, ETH_NATIVE_WALLET);
    assert.deepEqual(result, {
      ok: true,
      deposit: { asset: "native", amount: "0.000060687326699999", fromAddress: ETH_NATIVE_FROM, toWallet: ETH_NATIVE_WALLET },
    });
  });
});

test("verifyEthereumDeposit: the same real transaction against a different wallet is refused (it wasn't paid)", async () => {
  const routes = {
    receipt: new Map([[ETH_NATIVE_HASH, ETH_NATIVE_RECEIPT.result]]),
    tx: new Map([[ETH_NATIVE_HASH, ETH_NATIVE_TX.result]]),
  };
  await withEthereumStandIn(routes, async (rpcUrl) => {
    const result = await verifyEthereumDeposit(rpcUrl, ETH_NATIVE_HASH, "0x0000000000000000000000000000000000000000");
    assert.deepEqual(result, { ok: false, reason: "wrong_wallet" });
  });
});

test("verifyEthereumDeposit: a real ERC-20 (USDC) Transfer event to the configured wallet verifies with the token's real decimals", async () => {
  const routes = {
    receipt: new Map([[ETH_ERC20_HASH, ETH_ERC20_RECEIPT.result]]),
    tx: new Map([[ETH_ERC20_HASH, { to: ETH_ERC20_CONTRACT, value: "0x0", from: ETH_ERC20_FROM }]]),
    decimals: 6,
  };
  await withEthereumStandIn(routes, async (rpcUrl) => {
    const result = await verifyEthereumDeposit(rpcUrl, ETH_ERC20_HASH, ETH_ERC20_WALLET);
    assert.deepEqual(result, {
      ok: true,
      deposit: { asset: { contract: ETH_ERC20_CONTRACT }, amount: "0.130077", fromAddress: ETH_ERC20_FROM, toWallet: ETH_ERC20_WALLET },
    });
  });
});

test("verifyEthereumDeposit: a reverted transaction (receipt.status 0x0) is not_confirmed", async () => {
  const reverted = structuredClone(ETH_NATIVE_RECEIPT.result);
  reverted.status = "0x0";
  const routes = { receipt: new Map([[ETH_NATIVE_HASH, reverted]]), tx: new Map([[ETH_NATIVE_HASH, ETH_NATIVE_TX.result]]) };
  await withEthereumStandIn(routes, async (rpcUrl) => {
    const result = await verifyEthereumDeposit(rpcUrl, ETH_NATIVE_HASH, ETH_NATIVE_WALLET);
    assert.deepEqual(result, { ok: false, reason: "not_confirmed" });
  });
});

test("verifyEthereumDeposit: an unknown hash is not_found", async () => {
  await withEthereumStandIn({}, async (rpcUrl) => {
    const result = await verifyEthereumDeposit(rpcUrl, `0x${"5".repeat(64)}`, ETH_NATIVE_WALLET);
    assert.deepEqual(result, { ok: false, reason: "not_found" });
  });
});
