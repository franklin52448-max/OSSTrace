import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fanOffsets, placeNear, sideFor, sideForFlow } from "../src/tracer/lib/placement.ts";

test("sideFor: more outgoing than incoming goes outflow (right); a tie also goes outflow", () => {
  assert.equal(sideFor(5, 2), "outflow");
  assert.equal(sideFor(2, 5), "inflow");
  assert.equal(sideFor(3, 3), "outflow");
});

test("sideForFlow: an explicit tab context wins over the stats majority, even when it disagrees", () => {
  // Row has far more outgoing activity (9 vs 1), but the user had the "Incoming" tab open --
  // the explicit signal must win, not the stats guess.
  assert.equal(sideForFlow("in", 9, 1), "inflow");
  assert.equal(sideForFlow("out", 1, 9), "outflow");
});

test("sideForFlow: falls back to the stats majority only when there's no tab context (\"all\")", () => {
  assert.equal(sideForFlow("all", 9, 1), "outflow");
  assert.equal(sideForFlow("all", 1, 9), "inflow");
});

test("fanOffsets: starts at 0, then alternates +step/-step outward", () => {
  const offsets = fanOffsets(5, 100);
  assert.deepEqual(offsets, [0, 100, -100, 200, -200]);
});

test("placeNear: outflow places to the right of the base node", () => {
  const base = { x: 0, y: 0, w: 254, h: 72 };
  const pos = placeNear({ base, side: "outflow", occupied: [] });
  assert.ok(pos.x > base.x + base.w, "outflow position should be to the right of the base");
});

test("placeNear: inflow places to the left of the base node", () => {
  const base = { x: 1000, y: 0, w: 254, h: 72 };
  const pos = placeNear({ base, side: "inflow", occupied: [] });
  assert.ok(pos.x + 254 < base.x, "inflow position should be to the left of the base");
});

test("placeNear: avoids an occupied rect on the preferred side by fanning out vertically", () => {
  const base = { x: 0, y: 0, w: 254, h: 72 };
  // Occupy the exact spot an outflow placement would first try (dy = 0).
  const occupied = [{ x: 254 + 290, y: 0, w: 254, h: 72 }];
  const pos = placeNear({ base, side: "outflow", occupied });
  assert.notEqual(pos.y, 0, "should fan away from the occupied spot rather than overlap it");
});
