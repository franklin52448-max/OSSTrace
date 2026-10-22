import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileLabelStore, type Balance, type ChainAdapter, type ChainId, type TransactionsResult } from "@osstrace/core";
import { createVisualizerHandler } from "../src/http.ts";

/** A small, real ChainAdapter that records every call it gets — not a mocking framework. */
class RecordingAdapter implements ChainAdapter {
  readonly chain: ChainId;
  balanceCalls: string[] = [];

  constructor(chain: ChainId) {
    this.chain = chain;
  }

  async getBalance(address: string): Promise<Balance> {
    this.balanceCalls.push(address);
    return { chain: this.chain, address, native: { symbol: "ETH", amount: "1", decimals: 18 }, asOf: "2026-10-22T00:00:00Z" };
  }

  async getRecentTransactions(): Promise<TransactionsResult> {
    return { available: true, transactions: [] };
  }
}

async function withVisualizer(
  run: (ctx: { base: string; eth: RecordingAdapter }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "visualizer-http-test-"));
  const store = new JsonFileLabelStore(join(dir, "labels.json"));
  const eth = new RecordingAdapter("ethereum");
  const sol = new RecordingAdapter("solana");
  const handle = createVisualizerHandler({
    registry: new Map<ChainId, ChainAdapter>([
      ["ethereum", eth],
      ["solana", sol],
    ]),
    store,
  });
  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run({ base: `http://127.0.0.1:${port}`, eth });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

test("a malformed %-escape in the address gets a 400 and the server keeps serving", async () => {
  await withVisualizer(async ({ base, eth }) => {
    // Before the fix, decodeURIComponent threw outside any try/catch here and the URIError
    // crashed the whole Visualizer process (reproduced against the real server.ts/http.ts).
    const bad = await fetch(`${base}/graph/ethereum/%E0%A4%A`);
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /malformed URL encoding/);
    assert.equal(eth.balanceCalls.length, 0);

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200, "the server must still be up after the bad request");
  });
});

test("an unsupported chain gets a 400, not a crash", async () => {
  await withVisualizer(async ({ base }) => {
    const res = await fetch(`${base}/graph/bitcoin/something`);
    assert.equal(res.status, 400);
  });
});

test("a valid address returns a real graph report", async () => {
  await withVisualizer(async ({ base }) => {
    const res = await fetch(`${base}/graph/ethereum/0x252a8bd2319d8a555b872990601221b3a2053bce`);
    assert.equal(res.status, 200);
  });
});
