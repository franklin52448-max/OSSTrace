import { test } from "node:test";
import assert from "node:assert/strict";
import type { Bounty, BountyDeposit } from "@osstrace/contract";
import { compareDecimalAmounts } from "../src/decimalAmount.ts";
import { applyQuery, assetDescription, assetKey, assetLabel, boardAssets, fundingTotals, sortBounties, statusCounts } from "../src/bountyBoard.ts";

/** Test fixtures shaped exactly like GET /api/bounties rows; the board's own UI tests drive the real server. */
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

let seq = 0;
function deposit(chain: BountyDeposit["chain"], asset: BountyDeposit["asset"], amount: string): BountyDeposit {
  seq += 1;
  return { id: `d${seq}`, chain, asset, amount, txRef: `tx${seq}`, fromAddress: "from", toWallet: "to", recordedBy: "u", recordedAt: `2026-10-0${(seq % 9) + 1}T00:00:00.000Z` };
}

function bounty(id: string, openedAt: string, status: Bounty["status"], deposits: BountyDeposit[] = []): Bounty {
  return { id, status, title: id, description: "d", reward: "free text", openedBy: "u", openedAt, submissions: [], deposits };
}

test("fundingTotals: sums per asset exactly, keeps assets apart, and groups EVM contracts case-insensitively", () => {
  const totals = fundingTotals([
    deposit("solana", "native", "1.25"),
    deposit("ethereum", { contract: USDC_ETH }, "100"),
    deposit("solana", "native", "0.0000001"),
    deposit("ethereum", { contract: USDC_ETH.toLowerCase() }, "0.5"),
    deposit("solana", { contract: USDC_SOL }, "7"),
  ]);
  assert.deepEqual(
    totals.map((t) => [t.key, t.total, t.count]),
    [
      ["solana:native", "1.2500001", 2],
      [`ethereum:${USDC_ETH.toLowerCase()}`, "100.5", 2],
      [`solana:${USDC_SOL}`, "7", 1],
    ],
  );
  assert.deepEqual(fundingTotals([]), []);
});

test("assetLabel: native symbols per chain, real symbols for the default stablecoins, a shortened address for anything else", () => {
  assert.equal(assetLabel("solana", "native"), "SOL");
  assert.equal(assetLabel("bitcoin", "native"), "BTC");
  assert.equal(assetLabel("bnb", "native"), "BNB");
  assert.equal(assetLabel("ethereum", "native"), "ETH");
  assert.equal(assetLabel("robinhood", "native"), "ETH (Robinhood Chain)", "a second chain's ETH says which ETH");
  assert.equal(assetDescription("robinhood", "native"), "ETH on Robinhood Chain");
  assert.equal(assetLabel("ethereum", { contract: USDC_ETH }), "USDC");
  assert.equal(assetLabel("ethereum", { contract: USDC_ETH.toLowerCase() }), "USDC");
  assert.equal(assetLabel("solana", { contract: USDC_SOL }), "USDC");
  // A mint's case matters on Solana: a different-cased string is a different (unknown) mint.
  assert.equal(assetLabel("solana", { contract: USDC_SOL.toLowerCase() }), "epjfwd…dt1v");
  assert.equal(assetLabel("ethereum", { contract: "0x1111111111111111111111111111111111111111" }), "0x1111…1111");
  assert.equal(assetDescription("bnb", { contract: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" }), "USDC on BNB Chain");
  assert.notEqual(assetKey("ethereum", { contract: USDC_ETH }), assetKey("bnb", { contract: USDC_ETH }), "same contract string on two chains is two assets");
});

test("compareDecimalAmounts: exact, across differing fractional digits", () => {
  assert.equal(compareDecimalAmounts("0.1", "0.10"), 0);
  assert.equal(compareDecimalAmounts("2", "10"), -1);
  assert.equal(compareDecimalAmounts("10.000000000000000001", "10"), 1);
});

test("statusCounts + status filter: counts every status, and 'all' keeps everything", () => {
  const list = [bounty("a", "2026-10-01T00:00:00.000Z", "open"), bounty("b", "2026-10-02T00:00:00.000Z", "claimed"), bounty("c", "2026-10-03T00:00:00.000Z", "open"), bounty("d", "2026-10-04T00:00:00.000Z", "cancelled")];
  assert.deepEqual(statusCounts(list), { open: 2, claimed: 1, cancelled: 1, all: 4 });
  assert.deepEqual(applyQuery(list, { status: "open", sort: "newest" }).map((b) => b.id), ["c", "a"]);
  assert.deepEqual(applyQuery(list, { status: "claimed", sort: "newest" }).map((b) => b.id), ["b"]);
  assert.deepEqual(applyQuery(list, { status: "all", sort: "oldest" }).map((b) => b.id), ["a", "b", "c", "d"]);
});

test("sort by funded amount: only ever within one asset, never across assets; unfunded-in-that-asset bounties go last, newest first", () => {
  const sol = (amount: string) => deposit("solana", "native", amount);
  const usdc = (amount: string) => deposit("ethereum", { contract: USDC_ETH }, amount);
  const list = [
    bounty("small-sol", "2026-10-01T00:00:00.000Z", "open", [sol("0.5")]),
    bounty("big-usdc", "2026-10-02T00:00:00.000Z", "open", [usdc("5000")]), // a large number, but not SOL
    bounty("big-sol", "2026-10-03T00:00:00.000Z", "open", [sol("1.5"), sol("1")]), // 2.5 SOL across two deposits
    bounty("unfunded-old", "2026-10-04T00:00:00.000Z", "open"),
    bounty("unfunded-new", "2026-10-05T00:00:00.000Z", "open"),
    bounty("mid-sol", "2026-10-06T00:00:00.000Z", "open", [sol("2"), usdc("1")]),
  ];
  // 2.5 SOL > 2 SOL > 0.5 SOL, then every bounty with no SOL deposit (5000 USDC included), newest first.
  assert.deepEqual(sortBounties(list, "funded:solana:native").map((b) => b.id), ["big-sol", "mid-sol", "small-sol", "unfunded-new", "unfunded-old", "big-usdc"]);
  assert.deepEqual(sortBounties(list, `funded:ethereum:${USDC_ETH.toLowerCase()}`).map((b) => b.id).slice(0, 2), ["big-usdc", "mid-sol"]);
  assert.deepEqual(boardAssets(list).map((a) => a.key), ["solana:native", `ethereum:${USDC_ETH.toLowerCase()}`]);
  // The free-text reward is never part of any ordering.
  assert.deepEqual(sortBounties(list, "newest").map((b) => b.id), ["mid-sol", "unfunded-new", "unfunded-old", "big-sol", "big-usdc", "small-sol"]);
});
