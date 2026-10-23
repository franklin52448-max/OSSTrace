import { test } from "node:test";
import assert from "node:assert/strict";
import { pairsToCompare, sharedCounterparties } from "../src/tracer/lib/ops.ts";
import type { TraceNode } from "@osstrace/contract";

// "Find connections" (TracerPage.tsx) is two pure pieces glued to real API calls + addTransfersEdit
// (already covered elsewhere). These test the pure pieces directly -- pairing and set-intersection --
// without needing a server harness.

const addrNode = (id: string, chain: "ethereum" | "solana", address: string): TraceNode => ({
  id,
  kind: "address",
  currentPosition: { x: 0, y: 0 },
  createdAt: "2026-01-01T00:00:00.000Z",
  chain,
  address,
});

const entityNode = (id: string): TraceNode => ({ id, kind: "entity", currentPosition: { x: 0, y: 0 }, createdAt: "2026-01-01T00:00:00.000Z", entityID: "e1" });

test("pairsToCompare: every same-chain pair of address nodes, nothing else", () => {
  const a = addrNode("a", "solana", "Addr1");
  const b = addrNode("b", "solana", "Addr2");
  const c = addrNode("c", "ethereum", "0xabc");
  const e = entityNode("e");
  const pairs = pairsToCompare([a, b, c, e]);
  assert.equal(pairs.length, 1, "only the same-chain (solana) pair should be compared");
  assert.deepEqual(
    pairs.map(([x, y]) => [x.id, y.id]),
    [["a", "b"]],
  );
});

test("pairsToCompare: cross-chain nodes never pair, even with just two nodes", () => {
  const sol = addrNode("sol", "solana", "AddrX");
  const eth = addrNode("eth", "ethereum", "0xdef");
  assert.equal(pairsToCompare([sol, eth]).length, 0);
});

test("pairsToCompare: fewer than two address nodes means no pairs", () => {
  assert.equal(pairsToCompare([]).length, 0);
  assert.equal(pairsToCompare([addrNode("a", "solana", "Addr1")]).length, 0);
  assert.equal(pairsToCompare([entityNode("e1"), entityNode("e2")]).length, 0);
});

test("sharedCounterparties: finds a key present in both sets", () => {
  const setA = new Map([
    ["solana:X", "X"],
    ["solana:SHARED", "SHARED"],
  ]);
  const setB = new Map([
    ["solana:Y", "Y"],
    ["solana:SHARED", "SHARED"],
  ]);
  const shared = sharedCounterparties(setA, setB, new Set());
  assert.deepEqual(shared, [{ key: "solana:SHARED", address: "SHARED" }]);
});

test("sharedCounterparties: excludes keys in selfKeys (the two nodes being compared, not a real 'shared counterparty')", () => {
  const setA = new Map([["solana:B", "B"]]); // A's own counterparty list includes B itself
  const setB = new Map([["solana:A", "A"]]); // and B's includes A -- not a THIRD shared party
  const shared = sharedCounterparties(setA, setB, new Set(["solana:A", "solana:B"]));
  assert.deepEqual(shared, []);
});

test("sharedCounterparties: no overlap at all returns empty, not a false positive", () => {
  const setA = new Map([["solana:X", "X"]]);
  const setB = new Map([["solana:Y", "Y"]]);
  assert.deepEqual(sharedCounterparties(setA, setB, new Set()), []);
});

test("sharedCounterparties: empty sets never throw, just find nothing", () => {
  assert.deepEqual(sharedCounterparties(new Map(), new Map(), new Set()), []);
});
