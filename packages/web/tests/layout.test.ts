import { test } from "node:test";
import assert from "node:assert/strict";
import { forceLayout } from "../src/layout.ts";

function star(count: number) {
  const nodes = [{ id: "center", pinned: true }, ...Array.from({ length: count }, (_, i) => ({ id: `n${i}`, pinned: false }))];
  const links = nodes.slice(1).map((n, i) => (i % 2 === 0 ? { source: n.id, target: "center" } : { source: "center", target: n.id }));
  return { nodes, links };
}

test("forceLayout keeps the center pinned at the origin and every position finite", () => {
  const { nodes, links } = star(100);
  const pos = forceLayout(nodes, links);
  assert.deepEqual(pos.get("center"), { x: 0, y: 0 });
  assert.equal(pos.size, 101);
  for (const p of pos.values()) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  }
});

test("forceLayout spreads counterparties apart (no two nodes stacked on each other)", () => {
  const { nodes, links } = star(50);
  const pos = [...forceLayout(nodes, links).values()];
  let minDistance = Infinity;
  for (let i = 0; i < pos.length; i++) {
    for (let j = i + 1; j < pos.length; j++) {
      minDistance = Math.min(minDistance, Math.hypot(pos[i]!.x - pos[j]!.x, pos[i]!.y - pos[j]!.y));
    }
  }
  assert.ok(minDistance > 20, `closest pair only ${minDistance.toFixed(1)} apart`);
});

test("forceLayout is deterministic: same graph, same layout", () => {
  const { nodes, links } = star(20);
  assert.deepEqual([...forceLayout(nodes, links)], [...forceLayout(nodes, links)]);
});

test("forceLayout handles a center-only graph (history unavailable)", () => {
  const pos = forceLayout([{ id: "center", pinned: true }], []);
  assert.deepEqual([...pos], [["center", { x: 0, y: 0 }]]);
});
