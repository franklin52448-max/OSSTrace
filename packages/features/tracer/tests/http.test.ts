import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileLabelStore, type Balance, type ChainAdapter, type ChainId, type TransactionsResult } from "@osstrace/core";
import { createTracerHandler } from "../src/http.ts";

/** A small, real ChainAdapter that records every call it gets — not a mocking framework. */
class RecordingAdapter implements ChainAdapter {
  readonly chain: ChainId;
  calls: string[] = [];

  constructor(chain: ChainId) {
    this.chain = chain;
  }

  async getBalance(address: string): Promise<Balance> {
    return { chain: this.chain, address, native: { symbol: "ETH", amount: "1", decimals: 18 }, asOf: "2026-10-22T00:00:00Z" };
  }

  async getRecentTransactions(address: string): Promise<TransactionsResult> {
    this.calls.push(address);
    return { available: true, transactions: [] };
  }
}

async function withTracer(
  run: (ctx: { base: string; eth: RecordingAdapter }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "tracer-http-test-"));
  const store = new JsonFileLabelStore(join(dir, "labels.json"));
  const eth = new RecordingAdapter("ethereum");
  const sol = new RecordingAdapter("solana");
  const handle = createTracerHandler({
    registry: new Map<ChainId, ChainAdapter>([
      ["ethereum", eth],
      ["solana", sol],
    ]),
    store,
    // No wormhole dep wired here on purpose: these tests are about the single-chain crash fix,
    // not bridge behavior (bridges.test.ts already covers that separately).
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

test("a malformed %-escape in /trace/graph's address gets a 400 and the server keeps serving", async () => {
  await withTracer(async ({ base, eth }) => {
    // Before the fix, decodeURIComponent threw outside any try/catch here and the URIError
    // crashed the whole Tracer process (reproduced against the real server.ts/http.ts).
    const bad = await fetch(`${base}/trace/graph/ethereum/%E0%A4%A`);
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /malformed URL encoding/);
    assert.equal(eth.calls.length, 0);

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200, "the server must still be up after the bad request");
  });
});

test("a malformed %-escape in /trace/path's ?from= or ?to= gets a 400, not a crash", async () => {
  await withTracer(async ({ base }) => {
    const bad = await fetch(`${base}/trace/path/ethereum?from=%E0%A4%A&to=0x252a8bd2319d8a555b872990601221b3a2053bce`);
    assert.equal(bad.status, 400);
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
  });
});

test("asking for bridges=wormhole with no wormhole dependency configured is a clean 500, not a crash", async () => {
  await withTracer(async ({ base }) => {
    const res = await fetch(`${base}/trace/graph/ethereum/0x252a8bd2319d8a555b872990601221b3a2053bce?bridges=wormhole`);
    assert.equal(res.status, 500);
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
  });
});

test("a valid single-chain graph request succeeds", async () => {
  await withTracer(async ({ base }) => {
    const res = await fetch(`${base}/trace/graph/ethereum/0x252a8bd2319d8a555b872990601221b3a2053bce`);
    assert.equal(res.status, 200);
  });
});
