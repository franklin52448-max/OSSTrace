import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { TransactionsResult, TransactionSummary } from "@osstrace/core";
import { EthereumAdapter } from "../src/adapter.ts";
import {
  decodeCursor,
  encodeCursor,
  mergeHistory,
  mergeHistoryPage,
  requestedRows,
  type EthereumCursor,
  type EtherscanTokenTx,
  type EtherscanTx,
} from "../src/etherscan.ts";

// Cursor paging (ADR 0018) over recorded real mainnet rows: the Universal Router fixture is 9
// merged entries across 2 blocks (3 + 6), so small limits put page boundaries inside a busy block.

interface Fixture {
  address: string;
  txlist: EtherscanTx[];
  tokentx: EtherscanTokenTx[];
}

async function loadFixture(name: string): Promise<Fixture> {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Fixture;
}

const position = (row: { blockNumber: string; transactionIndex: string }): [number, number] => [
  Number(row.blockNumber),
  Number(row.transactionIndex),
];

/**
 * What Etherscan's `txlist`/`tokentx` return for `endblock` + `offset` + `sort=desc`, page 1:
 * rows up to and including `endBlock`, newest first, at most `offset` of them.
 */
function etherscanWindow<Row extends { blockNumber: string; transactionIndex: string }>(rows: readonly Row[], endBlock: number, offset: number): Row[] {
  return rows
    .filter((row) => Number(row.blockNumber) <= endBlock)
    .sort((a, b) => {
      const [ab, ai] = position(a);
      const [bb, bi] = position(b);
      return bb - ab || bi - ai;
    })
    .slice(0, offset);
}

/** Pages through the whole fixture the way the adapter does, returning every page. */
function pageThrough(fx: Fixture, limit: number): TransactionSummary[][] {
  const pages: TransactionSummary[][] = [];
  let before: EthereumCursor | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const requested = requestedRows(limit, before);
    const endBlock = before?.block ?? 99_999_999;
    const page = mergeHistoryPage(
      etherscanWindow(fx.txlist, endBlock, requested.native),
      etherscanWindow(fx.tokentx, endBlock, requested.token),
      fx.address,
      limit,
      before,
    );
    pages.push(page.transactions);
    if (!page.nextCursor) return pages;
    // Round-trip through the string form, exactly as a caller of the HTTP API would.
    before = decodeCursor(encodeCursor(page.nextCursor)) ?? undefined;
    assert.ok(before, "a cursor the adapter produced must decode");
  }
  throw new Error("paging never reached the end");
}

test("paging with ?before= walks the whole history in order: no overlap, no gap, at every page size", async () => {
  const fx = await loadFixture("universal-router-2-blocks.json");
  const everything = mergeHistory(fx.txlist, fx.tokentx, fx.address, 100).map((tx) => tx.hash);
  assert.equal(everything.length, 9);

  for (const limit of [1, 2, 3, 4, 5, 8, 9, 10]) {
    const pages = pageThrough(fx, limit);
    const walked = pages.flat().map((tx) => tx.hash);
    assert.deepEqual(walked, everything, `limit=${limit}: pages concatenated must equal the full history, in order`);
    for (const [i, page] of pages.entries()) {
      assert.ok(page.length <= limit, `limit=${limit}: page ${i} is over the limit`);
      // A full page can only say "there may be more" (Etherscan doesn't say whether a full window
      // was the last one), so the page after the true end can be empty — but only that last one.
      assert.ok(page.length > 0 || i === pages.length - 1, `limit=${limit}: page ${i} is empty mid-history`);
    }
  }
});

test("a second page starts right after the first: the limit=3 page boundary inside block 26243522", async () => {
  const fx = await loadFixture("universal-router-2-blocks.json");
  // Page 1 is block 26243522's three txs — a full txlist page, so there may be more.
  const first = mergeHistoryPage(etherscanWindow(fx.txlist, 99_999_999, 3), etherscanWindow(fx.tokentx, 99_999_999, 3), fx.address, 3);
  assert.deepEqual(first.transactions.map((tx) => tx.hash.slice(0, 6)), ["0x2923", "0xc268", "0x9d5e"]);
  assert.deepEqual(first.nextCursor, { block: 26243522, txIndex: 242, nativeSeen: 3, tokenSeen: 0 });

  // Page 2 re-fetches block 26243522 (endblock is inclusive) with 3 extra rows, so the 3 already
  // shown can't use up the page; they're filtered out and the next 3 older entries come back.
  const before = first.nextCursor!;
  const requested = requestedRows(3, before);
  assert.deepEqual(requested, { native: 6, token: 3 });
  const second = mergeHistoryPage(
    etherscanWindow(fx.txlist, before.block, requested.native),
    etherscanWindow(fx.tokentx, before.block, requested.token),
    fx.address,
    3,
    before,
  );
  assert.deepEqual(second.transactions.map((tx) => tx.hash.slice(0, 6)), ["0xbfe3", "0x097a", "0x5fee"]);
});

test("the last page has no nextCursor; a history that fits in one page has none either", async () => {
  const fx = await loadFixture("universal-router-2-blocks.json");
  assert.equal(mergeHistoryPage(fx.txlist, fx.tokentx, fx.address, 25).nextCursor, undefined);
  assert.equal(mergeHistoryPage([], [], fx.address, 25).nextCursor, undefined);
});

test("decodeCursor accepts only what encodeCursor produces", () => {
  const cursor = { block: 26243522, txIndex: 242, nativeSeen: 3, tokenSeen: 0 };
  assert.equal(encodeCursor(cursor), "26243522:242:3:0");
  assert.deepEqual(decodeCursor("26243522:242:3:0"), cursor);
  for (const bad of ["", "26243522", "26243522:242", "a:b:c:d", "1:2:3:4:5", "-1:2:3:4", "1.5:2:3:4", " 1:2:3:4"]) {
    assert.equal(decodeCursor(bad), null, JSON.stringify(bad));
  }
});

/**
 * A local HTTP server that answers the Etherscan v2 `txlist`/`tokentx` calls from the recorded
 * fixture rows, honouring `endblock`/`offset`/`sort=desc` the way Etherscan documents them — so
 * the adapter's real request-building and paging run end to end without a key. Records every
 * query it receives.
 */
async function withEtherscanStandIn(fx: Fixture, run: (url: string, queries: URLSearchParams[]) => Promise<void>): Promise<void> {
  const queries: URLSearchParams[] = [];
  const server: Server = createServer((req, res) => {
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    queries.push(params);
    const endBlock = Number(params.get("endblock"));
    const offset = Number(params.get("offset"));
    const source = params.get("action") === "txlist" ? fx.txlist : fx.tokentx;
    const rows = etherscanWindow<EtherscanTx | EtherscanTokenTx>(source, endBlock, offset);
    const body = rows.length > 0 ? { status: "1", message: "OK", result: rows } : { status: "0", message: "No transactions found", result: [] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/v2/api`, queries);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("EthereumAdapter: page 2 via `before` asks Etherscan for endblock = the cursor's block and returns the next, older set", async () => {
  const fx = await loadFixture("universal-router-2-blocks.json");
  await withEtherscanStandIn(fx, async (etherscanUrl, queries) => {
    const adapter = new EthereumAdapter({ rpcUrl: "http://127.0.0.1:9", etherscanApiKey: "test-key", etherscanUrl });

    const first = await adapter.getRecentTransactions(fx.address, 4);
    assert.equal(first.available, true);
    if (!first.available) return;
    assert.ok(first.nextCursor, "a full first page must offer a next page");
    assert.deepEqual(
      queries.map((q) => [q.get("action"), q.get("endblock"), q.get("offset")]).sort(),
      [
        ["tokentx", "99999999", "4"],
        ["txlist", "99999999", "4"],
      ],
      "page 1 is exactly the request the adapter always made",
    );

    queries.length = 0;
    const second: TransactionsResult = await adapter.getRecentTransactions(fx.address, 4, { before: first.nextCursor });
    assert.equal(second.available, true);
    if (!second.available) return;
    const cursor = decodeCursor(first.nextCursor)!;
    for (const q of queries) assert.equal(q.get("endblock"), String(cursor.block));

    const firstHashes = first.transactions.map((tx) => tx.hash);
    const secondHashes = second.transactions.map((tx) => tx.hash);
    assert.ok(secondHashes.length > 0, "page 2 must not be empty");
    assert.equal(secondHashes.filter((h) => firstHashes.includes(h)).length, 0, "page 2 must not overlap page 1");
    const everything = mergeHistory(fx.txlist, fx.tokentx, fx.address, 100).map((tx) => tx.hash);
    assert.deepEqual([...firstHashes, ...secondHashes], everything.slice(0, firstHashes.length + secondHashes.length));
  });
});

test("with a real ETHERSCAN_API_KEY: page 2 of real history is the next, older set", async (t) => {
  const apiKey = process.env["ETHERSCAN_API_KEY"];
  if (!apiKey) {
    t.skip("ETHERSCAN_API_KEY not set — skipping live Etherscan paging test");
    return;
  }
  // Etherscan's own documentation example address: real native txs and ERC-20 transfers.
  const address = "0x4e83362442b8d1bec281594cea3050c8eb01311c";
  const adapter = new EthereumAdapter({ rpcUrl: process.env["ETH_RPC_URL"] ?? "https://ethereum-rpc.publicnode.com", etherscanApiKey: apiKey });
  const first = await adapter.getRecentTransactions(address, 5);
  if (!first.available && /HTTP 5\d\d|fetch failed|rate limit/i.test(first.reason)) {
    t.skip(`Etherscan refused the request (${first.reason}) — skipping live network test`);
    return;
  }
  assert.equal(first.available, true, first.available ? "" : first.reason);
  if (!first.available) return;
  assert.ok(first.nextCursor, "this address has far more than 5 history entries");
  const second = await adapter.getRecentTransactions(address, 5, { before: first.nextCursor });
  assert.equal(second.available, true, second.available ? "" : second.reason);
  if (!second.available) return;
  // Same rows, one request: everything up to page 2's end, as a single limit=10 page.
  const both = await adapter.getRecentTransactions(address, 10);
  assert.equal(both.available, true);
  if (!both.available) return;
  const firstHashes = first.transactions.map((tx) => tx.hash);
  const secondHashes = second.transactions.map((tx) => tx.hash);
  assert.ok(secondHashes.length > 0);
  assert.equal(secondHashes.filter((h) => firstHashes.includes(h)).length, 0, "no overlap");
  assert.ok(new Date(second.transactions[0]!.timestamp) <= new Date(first.transactions.at(-1)!.timestamp), "page 2 is older");
  // A single page drops entries older than a full list's cut-off block, so it can be shorter
  // than 10: compare the stretch both cover.
  const k = Math.min(firstHashes.length + secondHashes.length, both.transactions.length);
  assert.deepEqual([...firstHashes, ...secondHashes].slice(0, k), both.transactions.map((tx) => tx.hash).slice(0, k));
});

test("EthereumAdapter: a cursor it didn't produce is reported as unavailable, before any Etherscan call", async () => {
  const fx = await loadFixture("universal-router-2-blocks.json");
  await withEtherscanStandIn(fx, async (etherscanUrl, queries) => {
    const adapter = new EthereumAdapter({ rpcUrl: "http://127.0.0.1:9", etherscanApiKey: "test-key", etherscanUrl });
    const result = await adapter.getRecentTransactions(fx.address, 4, { before: "not-a-cursor" });
    assert.equal(result.available, false);
    if (!result.available) assert.match(result.reason, /invalid `before` cursor for ethereum/);
    assert.equal(queries.length, 0);
  });
});
