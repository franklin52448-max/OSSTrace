import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { SolanaAdapter, summarizeTransaction } from "../src/adapter.ts";

// Solana's RPC really does return `blockTime: null` for some (very recent) signatures. These
// tests pin that such a transaction comes out with `timestamp: null` — never 1970-01-01, which is
// what the adapter used to fabricate (ADR 0016).

const RAYDIUM_SWAPPER = "6MtUE8BGGvThA9SvBP6jNoqzuV87G9yC4WsLRvVoS173";
const EPOCH = new Date(0).toISOString();

async function loadFixture(): Promise<{ raw: { result: ParsedTransactionWithMeta }; signature: string }> {
  const raw = JSON.parse(await readFile(new URL("./fixtures/raydium-v4-swap-transfer.json", import.meta.url), "utf8")) as {
    result: ParsedTransactionWithMeta;
  };
  return { raw, signature: raw.result.transaction.signatures[0]! };
}

test("blockTime: null on both the signature and the transaction gives timestamp: null, not the epoch", async () => {
  const { raw, signature } = await loadFixture();
  const tx = { ...raw.result, blockTime: null };
  const summary = summarizeTransaction({ signature, blockTime: null }, tx, RAYDIUM_SWAPPER);
  assert.equal(summary.timestamp, null);
  assert.notEqual(summary.timestamp, EPOCH);
  // Everything else about the transaction is still decoded as usual.
  assert.equal(summary.valueNative, "0.103275788");
  assert.equal(summary.status, "success");
});

test("details missing and blockTime: null still gives timestamp: null", () => {
  const summary = summarizeTransaction({ signature: "5".repeat(88), blockTime: null, err: null }, null, RAYDIUM_SWAPPER);
  assert.equal(summary.timestamp, null);
  assert.equal(summary.from, "unknown");
});

test("a real blockTime becomes its exact ISO timestamp", async () => {
  const { raw, signature } = await loadFixture();
  const summary = summarizeTransaction({ signature, blockTime: raw.result.blockTime ?? null }, raw.result, RAYDIUM_SWAPPER);
  assert.equal(summary.timestamp, new Date(1792616129 * 1000).toISOString());
});

test("signature list without a blockTime falls back to the fetched transaction's own blockTime", async () => {
  const { raw, signature } = await loadFixture();
  const summary = summarizeTransaction({ signature, blockTime: null }, raw.result, RAYDIUM_SWAPPER);
  assert.equal(summary.timestamp, new Date(1792616129 * 1000).toISOString());
});

/**
 * A concrete JSON-RPC stand-in (not a mocking framework): answers getSignaturesForAddress with one
 * signature whose blockTime is null, and the getTransaction batch with the recorded real mainnet
 * transaction, also with blockTime null — the full path real web3.js takes in getRecentTransactions.
 */
async function startRpc(raw: { result: ParsedTransactionWithMeta }, signature: string): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { id: string | number; method: string } | { id: string | number; method: string }[];
      const answer = (call: { id: string | number; method: string }) => {
        if (call.method === "getSignaturesForAddress") {
          return {
            jsonrpc: "2.0",
            id: call.id,
            result: [{ signature, slot: 1, err: null, memo: null, blockTime: null, confirmationStatus: "confirmed" }],
          };
        }
        if (call.method === "getTransaction") {
          return { jsonrpc: "2.0", id: call.id, result: { ...raw.result, blockTime: null } };
        }
        return { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: `unexpected method ${call.method}` } };
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test("getRecentTransactions end to end: an RPC reporting blockTime: null yields timestamp: null", async () => {
  const { raw, signature } = await loadFixture();
  const { server, url } = await startRpc(raw, signature);
  try {
    const result = await new SolanaAdapter({ rpcUrl: url }).getRecentTransactions(RAYDIUM_SWAPPER, 1);
    assert.equal(result.available, true);
    if (!result.available) return;
    assert.equal(result.transactions.length, 1);
    assert.equal(result.transactions[0]!.hash, signature);
    assert.equal(result.transactions[0]!.timestamp, null);
  } finally {
    server.close();
  }
});
