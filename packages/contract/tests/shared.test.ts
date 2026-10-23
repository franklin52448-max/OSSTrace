import { describe, expect, it } from "vitest";
import {
  addressNodeId,
  addTransfersEdit,
  aggregateEdgeId,
  applyTraceOps,
  applyVisualizerOps,
  CHAIN_NAMES,
  makeAddressNode,
  NATIVE_SYMBOLS,
  NODE_LABEL_MAX,
  NODE_NOTE_MAX,
  pairsToCompare,
  sharedCounterparties,
  DEFAULT_VISUALIZER_STATE,
  chainForAddress,
  detectChain,
  isAddressOnChain,
  isChain,
  isEvmChain,
  normalizeAddress,
  toChecksumAddress,
  transferEdgeId,
  type TraceDoc,
  type TraceNode,
  type TraceOp,
  type Transfer,
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
  it("treats bnb as EVM: same checksum form, same address shape, never detected as the default", () => {
    expect(normalizeAddress("bnb", "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    expect(isAddressOnChain("bnb", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toBe(true);
    expect(isAddressOnChain("bnb", "So11111111111111111111111111111111111111112")).toBe(false);
    expect(isAddressOnChain("solana", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toBe(false);
    // A bare 0x paste still defaults to ethereum -- bnb is only ever chosen explicitly.
    expect(detectChain("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toBe("ethereum");
    expect(isEvmChain("bnb") && isEvmChain("ethereum") && !isEvmChain("solana")).toBe(true);
    // A picker already on BNB keeps a pasted 0x address there; one on Solana follows the shape.
    expect(chainForAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "bnb")).toBe("bnb");
    expect(chainForAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "solana")).toBe("ethereum");
    expect(chainForAddress("So11111111111111111111111111111111111111112", "bnb")).toBe("solana");
  });
  it("treats robinhood as EVM too, and keeps its rows apart from Ethereum's for the same address", () => {
    const a = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    expect(normalizeAddress("robinhood", a.toLowerCase())).toBe(a);
    expect(isAddressOnChain("robinhood", a) && !isAddressOnChain("robinhood", "So11111111111111111111111111111111111111112")).toBe(true);
    expect(isEvmChain("robinhood")).toBe(true);
    expect(detectChain(a)).toBe("ethereum"); // only ever chosen explicitly
    expect(chainForAddress(a, "robinhood")).toBe("robinhood");
    const t = "11111111-1111-4111-8111-111111111111";
    expect(addressNodeId(t, "robinhood", a)).not.toBe(addressNodeId(t, "ethereum", a));
  });
  it("Base is an EVM chain: same address shape and checksum as Ethereum, but its own chain", () => {
    expect(isEvmChain("base")).toBe(true);
    expect(isEvmChain("solana")).toBe(false);
    expect(normalizeAddress("base", "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    expect(isAddressOnChain("base", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toBe(true);
    expect(isAddressOnChain("base", "So11111111111111111111111111111111111111112")).toBe(false);
    // A node for the same address on each chain is a different node, never merged.
    const t = "11111111-1111-4111-8111-111111111111";
    expect(addressNodeId(t, "base", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).not.toBe(addressNodeId(t, "ethereum", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"));
    expect(isChain("base")).toBe(true);
    expect(isChain("bsc")).toBe(false);
    expect(chainForAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "base")).toBe("base");
  });
  it("Arbitrum One, OP Mainnet, Zora, Lens Chain and the Data Network are EVM chains, each its own", () => {
    const addr = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    const t = "11111111-1111-4111-8111-111111111111";
    for (const chain of ["arbitrum", "optimism", "zora", "lens", "story"] as const) {
      expect(isChain(chain)).toBe(true);
      expect(isEvmChain(chain)).toBe(true);
      expect(normalizeAddress(chain, addr.toLowerCase())).toBe(addr);
      expect(isAddressOnChain(chain, "So11111111111111111111111111111111111111112")).toBe(false);
      expect(chainForAddress(addr, chain)).toBe(chain);
      expect(addressNodeId(t, chain, addr)).not.toBe(addressNodeId(t, "ethereum", addr));
    }
    // "story" is the chain id; what a person reads is the network's current name and token.
    expect(CHAIN_NAMES.story).toBe("Data Network");
    expect(NATIVE_SYMBOLS.story).toBe("DATA");
    expect(NATIVE_SYMBOLS.lens).toBe("GHO");
    expect([NATIVE_SYMBOLS.arbitrum, NATIVE_SYMBOLS.optimism, NATIVE_SYMBOLS.zora]).toEqual(["ETH", "ETH", "ETH"]);
    expect(isChain("data")).toBe(false);
    expect(isChain("arb")).toBe(false);
  });
  it("Gnosis Chain, Ronin and Rootstock are EVM chains, each its own, none paying gas in ETH", () => {
    const addr = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    const t = "11111111-1111-4111-8111-111111111111";
    for (const chain of ["gnosis", "ronin", "rootstock"] as const) {
      expect(isChain(chain)).toBe(true);
      expect(isEvmChain(chain)).toBe(true);
      expect(normalizeAddress(chain, addr.toLowerCase())).toBe(addr);
      expect(isAddressOnChain(chain, "So11111111111111111111111111111111111111112")).toBe(false);
      expect(chainForAddress(addr, chain)).toBe(chain);
      expect(addressNodeId(t, chain, addr)).not.toBe(addressNodeId(t, "ethereum", addr));
    }
    expect([CHAIN_NAMES.gnosis, CHAIN_NAMES.ronin, CHAIN_NAMES.rootstock]).toEqual(["Gnosis Chain", "Ronin", "Rootstock"]);
    // Gnosis Chain's gas token is the xDAI stablecoin and Rootstock's is RBTC -- never "ETH".
    expect([NATIVE_SYMBOLS.gnosis, NATIVE_SYMBOLS.ronin, NATIVE_SYMBOLS.rootstock]).toEqual(["xDAI", "RON", "RBTC"]);
    for (const alias of ["xdai", "rsk", "gno", "ron"]) expect(isChain(alias)).toBe(false);
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

describe("node label / note ops", () => {
  it("set_node_label / set_node_note set, clamp, clear, and skip a missing node", () => {
    const doc = { ...empty(), nodes: [node("a")] };
    let r = applyTraceOps(doc, [
      { type: "set_node_label", id: "a", label: "Hot wallet" },
      { type: "set_node_note", id: "a", note: "x".repeat(NODE_NOTE_MAX + 50) },
      { type: "set_node_label", id: "missing", label: "nope" },
    ]);
    expect(r.applied).toBe(2);
    expect(r.skipped).toBe(1);
    expect(r.doc.nodes[0]!.label).toBe("Hot wallet");
    expect(r.doc.nodes[0]!.note).toHaveLength(NODE_NOTE_MAX);
    r = applyTraceOps(r.doc, [
      { type: "set_node_label", id: "a", label: "y".repeat(NODE_LABEL_MAX + 1) },
      { type: "set_node_note", id: "a", note: "" },
    ]);
    expect(r.doc.nodes[0]!.label).toHaveLength(NODE_LABEL_MAX);
    expect(r.doc.nodes[0]!.note).toBeNull();
    r = applyTraceOps(r.doc, [{ type: "set_node_label", id: "a", label: null }]);
    expect(r.doc.nodes[0]!.label).toBeNull();
  });
});

describe("shared tracer edits (Find connections)", () => {
  const A = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
  const B = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
  const transfer = (id: string, from: string, to: string): Transfer => ({
    id, chain: "ethereum", txHash: id, blockNumber: 1, blockTimestamp: "2026-01-01T00:00:00.000Z",
    from: { chain: "ethereum", address: from }, to: { chain: "ethereum", address: to },
    tokenId: "native", tokenSymbol: "ETH", tokenName: "Ether", tokenDecimals: 18, amountRaw: "1", amount: "1", usd: 10, priceSource: "x",
  });

  it("pairsToCompare only pairs same-chain address nodes", () => {
    const a = makeAddressNode("t", { chain: "ethereum", address: A }, { x: 0, y: 0 });
    const b = makeAddressNode("t", { chain: "ethereum", address: B }, { x: 0, y: 0 });
    const s = makeAddressNode("t", { chain: "solana", address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" }, { x: 0, y: 0 });
    expect(pairsToCompare([a, b, s]).map(([x, y]) => [x.id, y.id])).toEqual([[a.id, b.id]]);
  });

  it("addTransfersEdit draws real transfers as edges, replaces the pair's aggregate, and skips duplicates", () => {
    const a = makeAddressNode("t", { chain: "ethereum", address: A }, { x: 0, y: 0 });
    const b = makeAddressNode("t", { chain: "ethereum", address: B }, { x: 0, y: 0 });
    const agg = edge(aggregateEdgeId("t", a.id, b.id), a.id, b.id);
    const doc = { ...empty(), nodes: [a, b], edges: [agg] };
    const t1 = transfer("tx1_0", A, B);
    const e = addTransfersEdit({ traceId: "t", doc, transfers: [t1, t1], positionFor: () => ({ x: 0, y: 0 }) });
    const r = applyTraceOps(doc, e.doOps);
    expect(r.doc.edges.map((x) => x.id)).toEqual([transferEdgeId("t", "ethereum", "tx1_0")]);
    expect(applyTraceOps(r.doc, e.undoOps).doc.edges.map((x) => x.id)).toEqual([agg.id]);
  });

  it("sharedCounterparties excludes the pair itself", () => {
    const setA = new Map([["k1", "x"], ["k2", "y"], ["self", "s"]]);
    const setB = new Map([["k2", "y"], ["self", "s"]]);
    expect(sharedCounterparties(setA, setB, new Set(["self"]))).toEqual([{ key: "k2", address: "y" }]);
  });
});
