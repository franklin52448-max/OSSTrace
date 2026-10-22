import { describe, expect, it } from "vitest";
import {
  addressNodeId,
  aggregateEdgeId,
  applyTraceOps,
  applyVisualizerOps,
  DEFAULT_VISUALIZER_STATE,
  detectChain,
  normalizeAddress,
  toChecksumAddress,
  transferEdgeId,
  type TraceDoc,
  type TraceNode,
  type TraceOp,
} from "../src/index.ts";

const node = (id: string, x = 0, y = 0): TraceNode => ({ id, kind: "address", currentPosition: { x, y }, createdAt: "2026-01-01T00:00:00.000Z" });
const empty = (): TraceDoc => ({ title: "", notes: "", shareable: false, nodes: [], edges: [] });
const edge = (id: string, a: string, b: string) => ({
  id, kind: "aggregate" as const, fromNodeID: a, toNodeID: b, createdAt: "2026-01-01T00:00:00.000Z",
  aggregate: { cachedUSDIn: 0, cachedTransactionCountIn: 0, cachedUSDOut: 0, cachedTransactionCountOut: 0, cachedAt: "2026-01-01T00:00:00.000Z" },
});

describe("EIP-55 checksum (official test vectors)", () => {
  it.each([
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
    "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
  ])("%s", (addr) => {
    expect(toChecksumAddress(addr.toLowerCase())).toBe(addr);
    expect(toChecksumAddress(addr.toUpperCase().replace("0X", "0x"))).toBe(addr);
  });
  it("rejects non-addresses", () => expect(() => toChecksumAddress("0x123")).toThrow());
});

describe("chain detection", () => {
  it("detects ethereum and solana", () => {
    expect(detectChain("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toBe("ethereum");
    expect(detectChain("So11111111111111111111111111111111111111112")).toBe("solana");
    expect(detectChain("hello")).toBeNull();
  });
  it("normalizes only EVM case", () => {
    expect(normalizeAddress("ethereum", "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    expect(normalizeAddress("solana", " So11111111111111111111111111111111111111112 ")).toBe("So11111111111111111111111111111111111111112");
  });
});

describe("deterministic ids", () => {
  const t = "11111111-1111-4111-8111-111111111111";
  it("same inputs give same id; EVM case does not matter", () => {
    const a = addressNodeId(t, "ethereum", "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed");
    const b = addressNodeId(t, "ethereum", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    expect(a).toBe(b);
    expect(addressNodeId("22222222-2222-4222-8222-222222222222", "ethereum", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).not.toBe(a);
  });
  it("aggregate edge id is direction independent", () => {
    expect(aggregateEdgeId(t, "a", "b")).toBe(aggregateEdgeId(t, "b", "a"));
    expect(transferEdgeId(t, "solana", "x_0")).not.toBe(transferEdgeId(t, "solana", "x_1"));
  });
});

describe("applyTraceOps", () => {
  it("create is idempotent (replay is a no-op)", () => {
    const ops: TraceOp[] = [{ type: "create_node", node: node("a") }];
    const once = applyTraceOps(empty(), ops);
    const twice = applyTraceOps(once.doc, ops);
    expect(once.applied).toBe(1);
    expect(twice.applied).toBe(0);
    expect(twice.skipped).toBe(1);
    expect(twice.doc.nodes).toHaveLength(1);
  });
  it("edge needs both endpoints; delete_node cascades to edges", () => {
    let r = applyTraceOps(empty(), [{ type: "create_edge", edge: edge("e", "a", "b") }]);
    expect(r.skipped).toBe(1);
    r = applyTraceOps(r.doc, [
      { type: "create_node", node: node("a") }, { type: "create_node", node: node("b") },
      { type: "create_edge", edge: edge("e", "a", "b") },
    ]);
    expect(r.doc.edges).toHaveLength(1);
    r = applyTraceOps(r.doc, [{ type: "delete_node", id: "a" }]);
    expect(r.doc.nodes.map((n) => n.id)).toEqual(["b"]);
    expect(r.doc.edges).toHaveLength(0);
  });
  it("position is last-writer-wins on clientTimestamp", () => {
    let r = applyTraceOps(empty(), [{ type: "create_node", node: node("a") }]);
    r = applyTraceOps(r.doc, [{ type: "update_node_position", id: "a", position: { x: 5, y: 5 }, clientTimestamp: "2026-01-01T00:00:02.000Z" }]);
    r = applyTraceOps(r.doc, [{ type: "update_node_position", id: "a", position: { x: 9, y: 9 }, clientTimestamp: "2026-01-01T00:00:01.000Z" }]);
    expect(r.skipped).toBe(1);
    expect(r.doc.nodes[0]!.currentPosition).toEqual({ x: 5, y: 5 });
  });
  it("missing ids are skipped, not errors; title is capped at 256", () => {
    const r = applyTraceOps(empty(), [
      { type: "delete_node", id: "nope" }, { type: "set_node_color", id: "nope", color: "red" },
      { type: "set_title", title: "x".repeat(400) },
    ]);
    expect(r.skipped).toBe(2);
    expect(r.doc.title).toHaveLength(256);
  });
});

describe("applyVisualizerOps", () => {
  const doc = () => ({ name: "", shareable: false, state: DEFAULT_VISUALIZER_STATE });
  it("pins positions (rounded) and unpins", () => {
    let r = applyVisualizerOps(doc(), [{ type: "set_position", nodeID: "n", position: { x: 1.4, y: 2.6 }, clientTimestamp: "2026-01-01T00:00:01.000Z" }]);
    expect(r.doc.state.positions.n).toEqual({ x: 1, y: 3 });
    r = applyVisualizerOps(r.doc, [{ type: "delete_position", nodeID: "n", clientTimestamp: "2026-01-01T00:00:02.000Z" }]);
    expect(r.doc.state.positions.n).toBeUndefined();
  });
  it("per-field last-writer-wins", () => {
    let r = applyVisualizerOps(doc(), [{ type: "set_name", name: "new", clientTimestamp: "2026-01-01T00:00:05.000Z" }]);
    r = applyVisualizerOps(r.doc, [{ type: "set_name", name: "old", clientTimestamp: "2026-01-01T00:00:01.000Z" }]);
    expect(r.doc.name).toBe("new");
    expect(r.skipped).toBe(1);
  });
});
