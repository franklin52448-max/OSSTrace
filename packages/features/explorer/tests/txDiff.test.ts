import { test } from "node:test";
import assert from "node:assert/strict";
import { diffTransactions } from "../src/txDiff.ts";
import { tx } from "./helpers.ts";

test("no baseline yet: nothing is reported, however many transactions there are", () => {
  const diff = diffTransactions(null, [tx(3), tx(2), tx(1)], 25);
  assert.deepEqual(diff.newTransactions, []);
  assert.equal(diff.windowOverflow, false);
});

test("a hash absent from the previous fetch is new; seen hashes are not", () => {
  const diff = diffTransactions([tx(2), tx(1)], [tx(3), tx(2), tx(1)], 25);
  assert.deepEqual(diff.newTransactions.map((t) => t.hash), ["0xtx3"]);
  assert.equal(diff.windowOverflow, false);
});

test("identical fetches report nothing", () => {
  assert.deepEqual(diffTransactions([tx(2), tx(1)], [tx(2), tx(1)], 25).newTransactions, []);
});

test("several new transactions are reported oldest first", () => {
  const diff = diffTransactions([tx(1)], [tx(4), tx(3), tx(2), tx(1)], 25);
  assert.deepEqual(diff.newTransactions.map((t) => t.hash), ["0xtx2", "0xtx3", "0xtx4"]);
});

test("full window: an unseen hash older than the previous window's oldest entry is not reported as new", () => {
  // Limit 3. The previous window covered tx5..tx3. This fetch shows tx6 (genuinely new) and tx1,
  // which is older than anything the previous window reached — an edge-of-window artifact, not news.
  const previous = [tx(5), tx(4), tx(3)];
  const current = [tx(6), tx(5), tx(1)];
  assert.deepEqual(diffTransactions(previous, current, 3).newTransactions.map((t) => t.hash), ["0xtx6"]);
});

test("window not full: the previous fetch was the whole history, so any unseen hash is new", () => {
  const diff = diffTransactions([tx(5)], [tx(5), tx(1)], 3);
  assert.deepEqual(diff.newTransactions.map((t) => t.hash), ["0xtx1"]);
});

test("a full window with no overlap flags a possible gap", () => {
  const diff = diffTransactions([tx(2), tx(1)], [tx(6), tx(5), tx(4)], 3);
  assert.equal(diff.windowOverflow, true);
  assert.deepEqual(diff.newTransactions.map((t) => t.hash), ["0xtx4", "0xtx5", "0xtx6"]);
});

test("an empty previous history is a real baseline: the first transaction ever is new, with no gap flag", () => {
  const diff = diffTransactions([], [tx(1)], 25);
  assert.deepEqual(diff.newTransactions.map((t) => t.hash), ["0xtx1"]);
  assert.equal(diff.windowOverflow, false);
});
