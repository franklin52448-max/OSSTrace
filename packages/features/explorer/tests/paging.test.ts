import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCache, JsonFileLabelStore, type ChainAdapter, type ChainId, type TransactionsResult } from "@osstrace/core";
import { EthereumAdapter } from "@osstrace/chain-ethereum";
import { SolanaAdapter } from "@osstrace/chain-solana";
import { createExplorerHandler } from "../src/http.ts";

// `?before=` end to end (ADR 0018): the real Explorer handler behind a real HTTP server, in front
// of the real chain adapters. Page 1's `transactions.nextCursor` goes back in as `?before=`, and
// page 2 must be the next set — not overlapping, not empty.

interface Report {
  transactions: TransactionsResult;
}

async function withExplorer(registry: Map<ChainId, ChainAdapter>, run: (base: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "explorer-paging-test-"));
  const handle = createExplorerHandler({ registry, store: new JsonFileLabelStore(join(dir, "labels.json")), cache: new InMemoryCache() });
  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

async function getTransactions(url: string): Promise<TransactionsResult> {
  const res = await fetch(url);
  assert.equal(res.status, 200, url);
  return ((await res.json()) as Report).transactions;
}

// Real recorded Universal Router mainnet rows (see the fixture's `_provenance`).
interface Row {
  blockNumber: string;
  transactionIndex: string;
  hash: string;
}
interface Fixture {
  address: string;
  txlist: Row[];
  tokentx: Row[];
}

/**
 * Answers Etherscan v2 `txlist`/`tokentx` (GET) from the recorded rows, honouring `endblock`,
 * `offset` and `sort=desc` as Etherscan documents them, and `eth_getBalance` (POST JSON-RPC) for
 * the balance side of the report.
 */
async function withEthereumStandIn(fx: Fixture, run: (url: string) => Promise<void>): Promise<void> {
  const server: Server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.method === "POST") {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x0" }));
      return;
    }
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const endBlock = Number(params.get("endblock"));
    const rows = (params.get("action") === "txlist" ? fx.txlist : fx.tokentx)
      .filter((row) => Number(row.blockNumber) <= endBlock)
      .sort((a, b) => Number(b.blockNumber) - Number(a.blockNumber) || Number(b.transactionIndex) - Number(a.transactionIndex))
      .slice(0, Number(params.get("offset")));
    res.end(JSON.stringify(rows.length > 0 ? { status: "1", message: "OK", result: rows } : { status: "0", message: "No transactions found", result: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("ethereum: ?before=<page 1's nextCursor> returns the next set, and paging walks the whole history", async () => {
  const fx = JSON.parse(
    await readFile(new URL("../../../chains/ethereum/tests/fixtures/universal-router-2-blocks.json", import.meta.url), "utf8"),
  ) as Fixture;
  await withEthereumStandIn(fx, async (standIn) => {
    const adapter = new EthereumAdapter({ rpcUrl: standIn, etherscanApiKey: "test-key", etherscanUrl: `${standIn}/v2/api` });
    await withExplorer(new Map<ChainId, ChainAdapter>([["ethereum", adapter]]), async (base) => {
      const url = `${base}/address/ethereum/${fx.address}?limit=4`;
      const first = await getTransactions(url);
      assert.equal(first.available, true);
      if (!first.available) return;
      assert.ok(first.nextCursor);

      const second = await getTransactions(`${url}&before=${encodeURIComponent(first.nextCursor)}`);
      assert.equal(second.available, true);
      if (!second.available) return;
      const firstHashes = first.transactions.map((tx) => tx.hash);
      const secondHashes = second.transactions.map((tx) => tx.hash);
      assert.equal(secondHashes.length, 4, "page 2 is a full next page, not empty");
      assert.equal(secondHashes.filter((h) => firstHashes.includes(h)).length, 0, "page 2 must not overlap page 1");

      // Keep going to the end: all 9 real entries, each exactly once, newest first.
      const seen = [...firstHashes, ...secondHashes];
      let cursor = second.nextCursor;
      while (cursor) {
        const next = await getTransactions(`${url}&before=${encodeURIComponent(cursor)}`);
        assert.equal(next.available, true);
        if (!next.available) return;
        seen.push(...next.transactions.map((tx) => tx.hash));
        cursor = next.nextCursor;
      }
      const all = await getTransactions(`${base}/address/ethereum/${fx.address}?limit=100`);
      assert.ok(all.available);
      if (!all.available) return;
      assert.equal(all.nextCursor, undefined, "a page holding the whole history offers no next page");
      assert.deepEqual(seen, all.transactions.map((tx) => tx.hash));
      assert.equal(seen.length, 9);
    });
  });
});

test("solana (live RPC): ?before=<page 1's nextCursor> returns the next set", async (t) => {
  const rpcUrl = process.env["SOLANA_RPC_URL"] ?? "https://api.mainnet-beta.solana.com";
  const adapter = new SolanaAdapter({ rpcUrl });
  // The System Program: always has a page 2.
  const address = "11111111111111111111111111111111";
  await withExplorer(new Map<ChainId, ChainAdapter>([["solana", adapter]]), async (base) => {
    const url = `${base}/address/solana/${address}?limit=3`;
    const first = await getTransactions(url);
    if (!first.available) {
      t.skip(`Solana RPC couldn't serve history (${first.reason.slice(0, 120)}) — skipping live network test`);
      return;
    }
    assert.equal(first.nextCursor, first.transactions.at(-1)?.hash);
    const second = await getTransactions(`${url}&before=${encodeURIComponent(first.nextCursor!)}`);
    if (!second.available) {
      t.skip(`Solana RPC couldn't serve page 2 (${second.reason.slice(0, 120)}) — skipping live network test`);
      return;
    }
    const firstHashes = first.transactions.map((tx) => tx.hash);
    const secondHashes = second.transactions.map((tx) => tx.hash);
    assert.equal(secondHashes.length, 3, "page 2 is a full next page, not empty");
    assert.equal(secondHashes.filter((h) => firstHashes.includes(h)).length, 0, "page 2 must not overlap page 1");
    assert.ok(new Date(second.transactions[0]!.timestamp) <= new Date(first.transactions.at(-1)!.timestamp), "page 2 is older than page 1");
  });
});
