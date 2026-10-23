import { test } from "node:test";
import assert from "node:assert/strict";
import { nextBalanceSort, sortBalances, type BalanceRow } from "../src/explorer/balanceSort.ts";

// The Holdings table had no sort at all (user report: "make it so you can sort by top holdings").
// sortBalances/nextBalanceSort are pure, tested directly here -- same approach explorers.ts's pure
// URL-building takes in explorerLinks.test.ts -- rendering BalancesTable itself would mean faking
// useBalances' react-query data, which these pure functions don't need.

const row = (over: Partial<BalanceRow>): BalanceRow => ({ tokenId: "t", symbol: "SYM", name: null, amount: "1", price: 1, usd: 1, ...over });

test("sortBalances: value descending (the default) puts the biggest USD holding first", () => {
  const rows = [row({ tokenId: "a", usd: 10 }), row({ tokenId: "b", usd: 500 }), row({ tokenId: "c", usd: 50 })];
  const sorted = sortBalances(rows, "value", "desc");
  assert.deepEqual(sorted.map((r) => r.tokenId), ["b", "c", "a"]);
});

test("sortBalances: value ascending reverses it", () => {
  const rows = [row({ tokenId: "a", usd: 10 }), row({ tokenId: "b", usd: 500 })];
  assert.deepEqual(sortBalances(rows, "value", "asc").map((r) => r.tokenId), ["a", "b"]);
});

test("sortBalances: holdings sorts by the raw token amount (a decimal string), not the symbol", () => {
  const rows = [row({ tokenId: "a", amount: "2.5" }), row({ tokenId: "b", amount: "1000000" }), row({ tokenId: "c", amount: "10" })];
  assert.deepEqual(sortBalances(rows, "holdings", "desc").map((r) => r.tokenId), ["b", "c", "a"]);
});

test("sortBalances: price sorts by the per-token price, independent of amount held", () => {
  const rows = [row({ tokenId: "a", price: 0.0001, amount: "1" }), row({ tokenId: "b", price: 5000, amount: "1" })];
  assert.deepEqual(sortBalances(rows, "price", "desc").map((r) => r.tokenId), ["b", "a"]);
});

test("sortBalances: asset sorts alphabetically by symbol (falls back to name, then tokenId)", () => {
  const rows = [row({ tokenId: "z", symbol: "ZETA" }), row({ tokenId: "a", symbol: "ALPHA" }), row({ tokenId: "m", symbol: null, name: "Middle" })];
  assert.deepEqual(sortBalances(rows, "asset", "asc").map((r) => r.tokenId), ["a", "m", "z"]);
});

test("sortBalances: a null price/usd always sorts last, in either direction -- an unpriced token is never 'the biggest value'", () => {
  const rows = [row({ tokenId: "priced", usd: 5 }), row({ tokenId: "unpriced", usd: null, price: null })];
  assert.deepEqual(sortBalances(rows, "value", "desc").map((r) => r.tokenId), ["priced", "unpriced"]);
  assert.deepEqual(sortBalances(rows, "value", "asc").map((r) => r.tokenId), ["priced", "unpriced"]);
});

test("sortBalances: ties between two null-usd rows don't crash and keep a stable-ish order", () => {
  const rows = [row({ tokenId: "a", usd: null }), row({ tokenId: "b", usd: null })];
  assert.equal(sortBalances(rows, "value", "desc").length, 2);
});

test("nextBalanceSort: clicking a new column starts it at descending", () => {
  assert.deepEqual(nextBalanceSort({ key: "value", dir: "desc" }, "price"), { key: "price", dir: "desc" });
  assert.deepEqual(nextBalanceSort({ key: "value", dir: "asc" }, "holdings"), { key: "holdings", dir: "desc" });
});

test("nextBalanceSort: clicking the already-active column toggles direction instead of resetting", () => {
  assert.deepEqual(nextBalanceSort({ key: "value", dir: "desc" }, "value"), { key: "value", dir: "asc" });
  assert.deepEqual(nextBalanceSort({ key: "value", dir: "asc" }, "value"), { key: "value", dir: "desc" });
});
