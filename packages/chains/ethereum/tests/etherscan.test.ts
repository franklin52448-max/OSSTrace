import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { decodeTokenTransfer, mergeHistory, summarizeNativeTx, type EtherscanTokenTx, type EtherscanTx } from "../src/etherscan.ts";

// Unit tests for the pure txlist/tokentx decoding, run against recorded real mainnet data (see
// each fixture's `_provenance`, and tokentx.live.test.ts, which re-checks the token rows
// against the chain itself). No network here.

interface Fixture {
  address: string;
  txlist: EtherscanTx[];
  tokentx: EtherscanTokenTx[];
}

async function loadFixture(name: string): Promise<Fixture> {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Fixture;
}

test("decodeTokenTransfer uses the token's real decimals, from/to and contract (MKR, Etherscan's own example row)", async () => {
  const fx = await loadFixture("mkr-redeem-0xe8c2.json");
  const row = fx.tokentx[0]!;
  const transfer = decodeTokenTransfer(row, fx.address);
  assert.deepEqual(transfer, {
    token: "0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2",
    symbol: "MKR",
    name: "Maker",
    decimals: 18,
    rawAmount: "5901522149285533025181",
    amount: "5901.522149285533025181",
    from: "0x642ae78fafbb8032da552d619ad43f1d81e4dd7c",
    to: "0x4e83362442b8d1bec281594cea3050c8eb01311c",
    direction: "in",
  });
});

test("direction is relative to the queried address, case-insensitively", async () => {
  const fx = await loadFixture("mkr-redeem-0xe8c2.json");
  const row = fx.tokentx[0]!;
  assert.equal(decodeTokenTransfer(row, "0x642AE78FAFBB8032DA552D619AD43F1D81E4DD7C").direction, "out");
  assert.equal(decodeTokenTransfer(row, fx.address.toUpperCase().replace("0X", "0x")).direction, "in");
});

test("a token whose decimals Etherscan doesn't report gets amount: null, never a guessed 18", async () => {
  const fx = await loadFixture("mkr-redeem-0xe8c2.json");
  const transfer = decodeTokenTransfer({ ...fx.tokentx[0]!, tokenDecimal: "" }, fx.address);
  assert.equal(transfer.decimals, null);
  assert.equal(transfer.amount, null);
  assert.equal(transfer.rawAmount, "5901522149285533025181");
});

test("a token reporting decimals beyond ERC-20's uint8 gets amount: null instead of freezing the process", async () => {
  // `decimals()` is uint8 in the ERC-20 standard, but tokenDecimal is whatever the contract
  // returned, and anyone can deploy a spam token and airdrop it to a popular address. Scaling by
  // 10^10,000,000 used to block the event loop for minutes (measured: decimals=100,000 already
  // took ~2.8s; 10,000,000 didn't finish within 2.5 minutes), freezing every request to the
  // Explorer for any address that ever received such a token.
  const fx = await loadFixture("mkr-redeem-0xe8c2.json");
  const started = Date.now();
  for (const tokenDecimal of ["256", "100000", "10000000", "99999999999999999999"]) {
    const transfer = decodeTokenTransfer({ ...fx.tokentx[0]!, tokenDecimal }, fx.address);
    assert.equal(transfer.decimals, null, tokenDecimal);
    assert.equal(transfer.amount, null, tokenDecimal);
    assert.equal(transfer.rawAmount, "5901522149285533025181");
  }
  assert.ok(Date.now() - started < 1000, "out-of-range decimals must be rejected, not computed");
  // The top of the real range still decodes exactly.
  const max = decodeTokenTransfer({ ...fx.tokentx[0]!, tokenDecimal: "255" }, fx.address);
  assert.equal(max.decimals, 255);
  assert.equal(max.amount, `0.${"5901522149285533025181".padStart(255, "0")}`);
});

test("summarizeNativeTx reports status from Etherscan's isError: \"1\" is failed, anything else is success", async () => {
  const fx = await loadFixture("mkr-redeem-0xe8c2.json");
  const row = fx.txlist[0]!;
  assert.equal(summarizeNativeTx(row, fx.address).status, "success");
  assert.equal(summarizeNativeTx({ ...row, isError: "1" }, fx.address).status, "failed");
  assert.equal(summarizeNativeTx({ ...row, isError: "0" }, fx.address).status, "success");
});

test("mergeHistory carries a failed native tx's status through, even with an attached token transfer", async () => {
  const fx = await loadFixture("mkr-redeem-0xe8c2.json");
  const merged = mergeHistory([{ ...fx.txlist[0]!, isError: "1" }], fx.tokentx, fx.address, 25);
  assert.equal(merged[0]!.status, "failed");
  assert.equal(merged[0]!.tokenTransfers?.length, 1); // still decoded — status says it didn't happen
});

test("a hash in both txlist and tokentx becomes one transaction: native view + its token transfers", async () => {
  const fx = await loadFixture("mkr-redeem-0xe8c2.json");
  const merged = mergeHistory(fx.txlist, fx.tokentx, fx.address, 25);
  assert.equal(merged.length, 1);
  const tx = merged[0]!;
  assert.equal(tx.hash, "0xe8c208398bd5ae8e4c237658580db56a2a94dfa0ca382c99b776fa6e7d31d5b4");
  assert.equal(tx.timestamp, "2017-12-14T08:32:43.000Z");
  // Native view, unchanged: this address sent the tx (0 ETH) to the redeem contract.
  assert.equal(tx.from, "0x4e83362442b8d1bec281594cea3050c8eb01311c");
  assert.equal(tx.to, "0x642ae78fafbb8032da552d619ad43f1d81e4dd7c");
  assert.equal(tx.valueNative, "0");
  assert.equal(tx.direction, "out");
  // ...and the MKR it got back is reported separately, with its own direction.
  assert.equal(tx.tokenTransfers?.length, 1);
  assert.equal(tx.tokenTransfers?.[0]?.amount, "5901.522149285533025181");
  assert.equal(tx.tokenTransfers?.[0]?.direction, "in");
});

test("native-only transactions keep exactly their old shape (no tokenTransfers key at all)", async () => {
  const fx = await loadFixture("universal-router-2-blocks.json");
  const merged = mergeHistory(fx.txlist, fx.tokentx, fx.address, 25);
  const nativeOnly = merged.find((tx) => tx.hash === "0x2923294476de618fe8590ebca42260c23afeaf6803cfeed11015b719198549df");
  assert.ok(nativeOnly);
  assert.equal("tokenTransfers" in nativeOnly, false);
  assert.equal(nativeOnly.valueNative, "0.154165605");
  assert.equal(nativeOnly.direction, "in");
});

test("a token-only transaction is included, mirroring its first transfer, with valueNative 0", async () => {
  const fx = await loadFixture("universal-router-2-blocks.json");
  const merged = mergeHistory(fx.txlist, fx.tokentx, fx.address, 25);
  const tokenOnly = merged.find((tx) => tx.hash === "0x9fbf8274988fe55ecea679b8a86adf09cfc4a7ac3e812ca4e4ff16847447511d");
  assert.ok(tokenOnly);
  assert.equal(tokenOnly.valueNative, "0");
  assert.equal(tokenOnly.from, "0x66a9893cc07d91d95644aedd05d03f95e1dba8af");
  assert.equal(tokenOnly.to, "0x000000000004444c5dc75cb358380d2e3de08a90");
  assert.equal(tokenOnly.direction, "out");
  // Both real L3 legs of this tx are kept: received from one address, passed on to another.
  assert.deepEqual(
    tokenOnly.tokenTransfers?.map((t) => [t.symbol, t.amount, t.direction]),
    [
      ["L3", "3710.311367700367088216", "out"],
      ["L3", "3710.311367700367088216", "in"],
    ],
  );
});

test("merged history is newest-first by block then transaction index, one entry per hash", async () => {
  const fx = await loadFixture("universal-router-2-blocks.json");
  const merged = mergeHistory(fx.txlist, fx.tokentx, fx.address, 25);
  assert.equal(merged.length, fx.txlist.length + 1, "8 native txs + 1 token-only tx");
  assert.equal(new Set(merged.map((tx) => tx.hash)).size, merged.length);
  // The token-only tx (block 26243521, index 63) sits between index 72 and index 44 of that block.
  const order = merged.map((tx) => tx.hash.slice(0, 6));
  assert.deepEqual(order, ["0x2923", "0xc268", "0x9d5e", "0xbfe3", "0x097a", "0x5fee", "0x1267", "0x9fbf", "0x9b1d"]);
});

test("the merged result never exceeds the requested limit", async () => {
  const fx = await loadFixture("universal-router-2-blocks.json");
  assert.equal(mergeHistory(fx.txlist, fx.tokentx, fx.address, 4).length, 4);
});

test("a full page's cut-off block drops older entries from the other list instead of showing a gap", async () => {
  const fx = await loadFixture("universal-router-2-blocks.json");
  // What a real limit=3 txlist page would be: the newest 3 rows, all in block 26243522 — so a
  // 4th, older native tx might exist that this page didn't return. The tokentx-only tx in block
  // 26243521 is older than that cut-off; showing it would imply nothing native happened between.
  const nativePage = fx.txlist.slice(0, 3);
  const merged = mergeHistory(nativePage, fx.tokentx, fx.address, 3);
  assert.deepEqual(
    merged.map((tx) => tx.hash.slice(0, 6)),
    ["0x2923", "0xc268", "0x9d5e"],
  );
});

test("empty history on both sides is an empty list", () => {
  assert.deepEqual(mergeHistory([], [], "0x0000000000000000000000000000000000000001", 25), []);
});
