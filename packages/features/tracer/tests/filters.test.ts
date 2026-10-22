import { test } from "node:test";
import assert from "node:assert/strict";
import type { GraphEdge } from "@osstrace/visualizer/src/graph.ts";
import { edgeMatchesFilters } from "../src/filters.ts";

function nativeEdge(timestamp: string | null): GraphEdge {
  return {
    id: "h1",
    hash: "h1",
    source: `0x${"a".repeat(40)}`,
    target: `0x${"b".repeat(40)}`,
    direction: "out",
    kind: "native",
    valueNative: "1",
    timestamp,
  };
}

test("a dated edge passes or fails since/until on its real timestamp", () => {
  const edge = nativeEdge("2026-06-01T00:00:00.000Z");
  assert.equal(edgeMatchesFilters(edge, { sinceTimestamp: "2026-01-01T00:00:00Z" }), true);
  assert.equal(edgeMatchesFilters(edge, { sinceTimestamp: "2026-07-01T00:00:00Z" }), false);
  assert.equal(edgeMatchesFilters(edge, { untilTimestamp: "2026-07-01T00:00:00Z" }), true);
  assert.equal(edgeMatchesFilters(edge, { untilTimestamp: "2026-01-01T00:00:00Z" }), false);
});

test("an undated edge (timestamp: null) fails a since filter — unknown never counts as matching", () => {
  assert.equal(edgeMatchesFilters(nativeEdge(null), { sinceTimestamp: "1970-01-01T00:00:00Z" }), false);
});

test("an undated edge (timestamp: null) fails an until filter too", () => {
  assert.equal(edgeMatchesFilters(nativeEdge(null), { untilTimestamp: "2100-01-01T00:00:00Z" }), false);
});

test("an undated edge fails a since+until window that every real date would pass", () => {
  assert.equal(
    edgeMatchesFilters(nativeEdge(null), { sinceTimestamp: "1970-01-01T00:00:00Z", untilTimestamp: "2100-01-01T00:00:00Z" }),
    false,
  );
});

test("an undated edge still passes filters that don't involve time", () => {
  assert.equal(edgeMatchesFilters(nativeEdge(null), {}), true);
  assert.equal(edgeMatchesFilters(nativeEdge(null), { token: "native", minAmount: "1" }), true);
});
