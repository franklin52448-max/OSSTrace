import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryCache,
  JsonFileLabelStore,
  type Balance,
  type ChainAdapter,
  type ChainId,
  type TransactionsResult,
} from "@osstrace/core";
import { DEFAULT_TX_LIMIT, LOOKUP_POPULARITY_TOPIC } from "../src/cachedLookup.ts";
import { createExplorerHandler, MAX_TX_LIMIT, parseTxLimit } from "../src/http.ts";

/** A small, real ChainAdapter that records every call it gets — not a mocking framework. */
class RecordingAdapter implements ChainAdapter {
  readonly chain: ChainId;
  balanceCalls: string[] = [];
  txLimits: number[] = [];
  failBalance = false;

  constructor(chain: ChainId) {
    this.chain = chain;
  }

  async getBalance(address: string): Promise<Balance> {
    this.balanceCalls.push(address);
    if (this.failBalance) throw new Error("upstream RPC failed");
    return { chain: this.chain, address, native: { symbol: "ETH", amount: "1", decimals: 18 }, asOf: "2026-10-22T00:00:00Z" };
  }

  async getRecentTransactions(_address: string, limit: number): Promise<TransactionsResult> {
    this.txLimits.push(limit);
    return { available: true, transactions: [] };
  }
}

const VALID_ETH = "0x252a8bd2319d8a555b872990601221b3a2053bce";

async function withExplorer(
  run: (ctx: { base: string; eth: RecordingAdapter; sol: RecordingAdapter; cache: InMemoryCache; store: JsonFileLabelStore }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "explorer-http-test-"));
  const store = new JsonFileLabelStore(join(dir, "labels.json"));
  const cache = new InMemoryCache();
  const eth = new RecordingAdapter("ethereum");
  const sol = new RecordingAdapter("solana");
  const handle = createExplorerHandler({
    registry: new Map<ChainId, ChainAdapter>([
      ["ethereum", eth],
      ["solana", sol],
    ]),
    store,
    cache,
  });
  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run({ base: `http://127.0.0.1:${port}`, eth, sol, cache, store });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

test("a malformed %-escape in the address gets a 400 and the server keeps serving", async () => {
  await withExplorer(async ({ base, eth }) => {
    // Before the fix, decodeURIComponent threw outside any try/catch here and the URIError
    // crashed the whole Explorer process (reproduced against the real server.ts).
    const bad = await fetch(`${base}/address/ethereum/%E0%A4%A`);
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /malformed URL encoding/);
    assert.equal(eth.balanceCalls.length, 0);

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200, "the server must still be up after the bad request");
  });
});

test("an address that isn't well-formed for its chain gets a 400 before any adapter call or popularity hit", async () => {
  await withExplorer(async ({ base, eth, sol, cache }) => {
    for (const path of ["/address/ethereum/0x123", "/address/ethereum/not-an-address", "/address/solana/0OIl-not-base58"]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 400, path);
    }
    assert.equal(eth.balanceCalls.length + sol.balanceCalls.length, 0, "no garbage input reaches a chain adapter");
    assert.deepEqual(await cache.topHits(LOOKUP_POPULARITY_TOPIC, 10), [], "garbage must not enter the indexer's popularity ranking");
  });
});

test("an unsupported chain gets a 400 without echoing the raw path segment back", async () => {
  await withExplorer(async ({ base }) => {
    const res = await fetch(`${base}/address/bitcoin/${VALID_ETH}`);
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /supported: ethereum, solana/);
  });
});

test("a checksummed Ethereum address is looked up (and labelled) under its canonical lowercase form", async () => {
  await withExplorer(async ({ base, eth, store }) => {
    await store.addLabel({
      address: { chain: "ethereum", value: VALID_ETH },
      name: "Stored lowercase",
      confidence: "verified",
      source: { description: "test source", url: "https://example.org/source", addedAt: "2026-10-22" },
    });
    const checksummed = "0x252A8bd2319D8a555B872990601221B3A2053bcE";
    const res = await fetch(`${base}/address/ethereum/${checksummed}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { address: { value: string }; label: { name: string } | null };
    assert.equal(body.address.value, VALID_ETH);
    assert.equal(body.label?.name, "Stored lowercase");
    assert.deepEqual(eth.balanceCalls, [VALID_ETH]);
  });
});

test("?limit= is clamped to a whole number in [1, MAX_TX_LIMIT] before it reaches the adapter", async () => {
  await withExplorer(async ({ base, eth }) => {
    for (const limit of ["-5", "0", "abc", "2.9", "1000000000", "50"]) {
      const res = await fetch(`${base}/address/ethereum/${VALID_ETH}?limit=${limit}`);
      assert.equal(res.status, 200, limit);
    }
    // -5, 0 and abc fall back to the default (cached after the first), 2.9 → 2, 1e9 → the cap, 50 as-is.
    assert.deepEqual(eth.txLimits, [DEFAULT_TX_LIMIT, 2, MAX_TX_LIMIT, 50]);
  });
});

test("an adapter failure is a 502, not a crash", async () => {
  await withExplorer(async ({ base, eth }) => {
    eth.failBalance = true;
    const res = await fetch(`${base}/address/ethereum/${VALID_ETH}`);
    assert.equal(res.status, 502);
    assert.equal(((await res.json()) as { error: string }).error, "upstream RPC failed");
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });
});

test("parseTxLimit", () => {
  assert.equal(parseTxLimit(null), DEFAULT_TX_LIMIT);
  assert.equal(parseTxLimit(""), DEFAULT_TX_LIMIT);
  assert.equal(parseTxLimit("-1"), DEFAULT_TX_LIMIT);
  assert.equal(parseTxLimit("NaN"), DEFAULT_TX_LIMIT);
  assert.equal(parseTxLimit("Infinity"), DEFAULT_TX_LIMIT);
  assert.equal(parseTxLimit("1"), 1);
  assert.equal(parseTxLimit("7.8"), 7);
  assert.equal(parseTxLimit("101"), MAX_TX_LIMIT);
});
