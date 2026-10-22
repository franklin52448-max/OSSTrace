import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileLabelStore, type Balance, type ChainAdapter, type ChainId, type TransactionsResult } from "@osstrace/core";
import { createRiskScoringHandler } from "../src/http.ts";

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

async function withRiskServer(
  run: (ctx: { base: string; eth: RecordingAdapter }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "risk-http-test-"));
  const store = new JsonFileLabelStore(join(dir, "labels.json"));
  const eth = new RecordingAdapter("ethereum");
  const sol = new RecordingAdapter("solana");
  const handle = createRiskScoringHandler({
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
  await withRiskServer(async ({ base, eth }) => {
    // Before this fix, decodeURIComponent threw outside any try/catch here, and the real
    // uncaught URIError crashed the whole Node process (confirmed live against the real
    // server.ts/http.ts: a second, well-formed request never got a response because the process
    // had already exited).
    const bad = await fetch(`${base}/risk/ethereum/%E0%A4%A`);
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /malformed URL encoding/);
    assert.equal(eth.calls.length, 0);

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200, "the server must still be up after the bad request");
  });
});

test("an unsupported chain gets a 400, not a crash", async () => {
  await withRiskServer(async ({ base }) => {
    const res = await fetch(`${base}/risk/bitcoin/something`);
    assert.equal(res.status, 400);
  });
});

test("an address that isn't well-formed for its chain gets a 400 before any adapter call", async () => {
  await withRiskServer(async ({ base, eth }) => {
    const res = await fetch(`${base}/risk/ethereum/not-an-address`);
    assert.equal(res.status, 400);
    assert.equal(eth.calls.length, 0);
  });
});

test("a valid, untagged address scores none/0 with a real adapter call", async () => {
  await withRiskServer(async ({ base, eth }) => {
    const res = await fetch(`${base}/risk/ethereum/0x252a8bd2319d8a555b872990601221b3a2053bce`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tier: string; score: number };
    assert.equal(body.tier, "none");
    assert.equal(body.score, 0);
    assert.ok(eth.calls.length > 0, "an untagged address needs at least one adapter call to search its graph");
  });
});

test("query params (maxHops/breadth/txLimit/maxCalls) are accepted and clamped, not rejected", async () => {
  await withRiskServer(async ({ base }) => {
    const res = await fetch(`${base}/risk/ethereum/0x252a8bd2319d8a555b872990601221b3a2053bce?maxHops=1&breadth=2&txLimit=5&maxCalls=3`);
    assert.equal(res.status, 200);
  });
});
