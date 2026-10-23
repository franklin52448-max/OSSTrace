import "./harness/env.ts";
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { addressNodeId, applyTraceOps, type TraceDoc, type TraceEdge, type TraceNode, type TraceOp } from "@osstrace/contract";

// The pure half of the agent panel: turning a turn's ops into one undoable edit, and wording each
// tool call from its real result fields. (The page-level wiring is covered by tracerAgent.test.ts.)

// Loaded after env.ts has registered its .tsx compile hook (a static import would load first).
type M = typeof import("../src/tracer/agent/toolCalls.ts");
let agentEdit: M["agentEdit"];
let invertOps: M["invertOps"];
let describeToolCall: M["describeToolCall"];
before(async () => {
  ({ agentEdit, invertOps, describeToolCall } = await import("../src/tracer/agent/toolCalls.ts"));
});

const TRACE = "scratch";
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const node = (address: string, x = 0): TraceNode => ({
  id: addressNodeId(TRACE, "ethereum", address),
  kind: "address",
  chain: "ethereum",
  address,
  displayAddress: { chain: "ethereum", address },
  currentPosition: { x, y: 0 },
  createdAt: "2026-10-01T00:00:00.000Z",
});
const agg = (id: string, from: string, to: string, usdOut: number): TraceEdge => ({
  id,
  kind: "aggregate",
  fromNodeID: from,
  toNodeID: to,
  createdAt: "2026-10-01T00:00:00.000Z",
  aggregate: { cachedUSDIn: 0, cachedTransactionCountIn: 0, cachedUSDOut: usdOut, cachedTransactionCountOut: usdOut ? 1 : 0, cachedAt: "2026-10-01T00:00:00.000Z" },
});
const doc = (nodes: TraceNode[], edges: TraceEdge[] = [], notes = ""): TraceDoc => ({ title: "t", notes, shareable: false, nodes, edges });
const byId = (ns: TraceNode[]) => [...ns].sort((x, y) => x.id.localeCompare(y.id));

test("undo ops computed for a turn really restore the document, whatever the mix of ops", () => {
  const a = { ...node(A), label: "old name", note: null, color: null };
  const b = node(B, 400);
  const before = doc([a, b], [agg("e1", a.id, b.id, 5)], "old notes");
  const ops: TraceOp[] = [
    { type: "set_node_label", id: a.id, label: "Hot wallet" },
    { type: "set_node_note", id: a.id, note: "seen in case 7" },
    { type: "set_node_color", id: a.id, color: "red" },
    { type: "set_notes", notes: "new notes" },
    { type: "delete_node", id: b.id },
    { type: "create_node", node: node("0x3333333333333333333333333333333333333333", 800) },
  ];
  const after = applyTraceOps(before, ops).doc;
  assert.notDeepEqual(after, before);
  const restored = applyTraceOps(after, invertOps(before, ops)).doc;
  assert.deepEqual(byId(restored.nodes), byId(before.nodes));
  assert.equal(restored.notes, "old notes");
  assert.deepEqual(restored.edges.map((e) => e.id), ["e1"], "the deleted node's edge comes back too");
});

test("ops creating something that's already there get no undo (undo never deletes what the user had)", () => {
  const a = node(A);
  assert.deepEqual(invertOps(doc([a]), [{ type: "create_node", node: a }]), []);
});

test("agentEdit: one edit labelled for the undo stack, using the server's after-turn copy of created edges", () => {
  const a = node(A);
  const b = node(B, 400);
  const created = agg("e2", a.id, b.id, 0); // created with zero totals...
  const after = { title: "t", notes: "", nodes: [a, b], edges: [agg("e2", a.id, b.id, 1234)] }; // ...then totalled server-side
  const edit = agentEdit(doc([a]), [{ type: "create_node", node: b }, { type: "create_edge", edge: created }], after);
  assert.ok(edit);
  assert.equal(edit.label, "Agent changes");
  const e = edit.doOps.find((o) => o.type === "create_edge");
  assert.equal(e?.type === "create_edge" && e.edge.kind === "aggregate" ? e.edge.aggregate.cachedUSDOut : null, 1234);
  assert.deepEqual(edit.undoOps, [{ type: "delete_edge", id: "e2" }, { type: "delete_node", id: b.id }]);
  assert.equal(agentEdit(doc([a]), [], after), null, "a turn that changed nothing is no edit at all");
});

test("describeToolCall words only what each real result says", () => {
  const a = node(A);
  const d = doc([a]);
  const say = (tool: string, result: Record<string, unknown>) => {
    const s = describeToolCall({ tool, args: {}, result }, d);
    return `${s.status}: ${s.summary}`;
  };
  assert.equal(say("add_node", { ok: true, nodeId: a.id, alreadyOnCanvas: false }), "applied: Added 0x1111…1111");
  assert.equal(say("add_node", { ok: true, nodeId: a.id, alreadyOnCanvas: true }), "read: 0x1111…1111 was already on the canvas");
  assert.equal(say("add_node", { ok: false, error: "That isn't a valid address." }), "failed: That isn't a valid address.");
  assert.equal(say("find_connections", { ok: true, connections: [], edgesAdded: 0, pairsFailed: 1 }), "read: No direct connections found, 1 pair couldn't be checked");
  assert.equal(
    say("find_connections", { ok: true, connections: [], edgesAdded: 0, pairsWithPartialHistory: 1 }),
    "read: No direct connections in the history loaded so far (older history isn't loaded, so not proof there are none)",
  );
  assert.equal(say("find_connections", { ok: true, connections: [{}], edgesAdded: 1, pairsWithPartialHistory: 1 }), "applied: Found 1 direct connection, drew 1 edge");
  assert.equal(say("find_connections", { ok: true, connections: [{}, {}], edgesAdded: 2, indirectLeads: [{}] }), "applied: Found 2 direct connections, drew 2 edges, 1 possible indirect link (shared counterparties, not drawn)");
  assert.equal(say("find_connections", { ok: true, connections: [{}], edgesAdded: 1, transfersNotDrawnTraceFull: 2 }), "applied: Found 1 direct connection, drew 1 edge, 2 transfers not drawn (the trace is full)");
  assert.equal(say("expand_node", { ok: true, rootNodeId: a.id, nodesAdded: 3, edgesAdded: 3, note: "Stopped short: some nodes were not expanded" }), "applied: Expanded 0x1111…1111: 3 nodes, 3 edges added (partial: some nodes couldn't be expanded)");
  assert.equal(
    say("expand_node", { ok: true, rootNodeId: a.id, nodesAdded: 2, edgesAdded: 2, nodesWithPartialHistory: 1, note: "Aggregate edges carry real totals from the transfer history loaded so far. For 1 of the expanded nodes the transfer history is not fully loaded: ..." }),
    "applied: Expanded 0x1111…1111: 2 nodes, 2 edges added (ranked from history that isn't fully loaded yet)",
  );
  assert.equal(say("list_transfers",{ ok: true, transfers: [{}, {}], sortedBy: "usd desc" }), "read: Looked at 2 transfers, sorted by usd desc");
  assert.equal(say("remove_node", { ok: true, removedNodeId: a.id, edgesRemoved: 2 }), "applied: Removed a node and 2 edges");
  assert.equal(say("annotate_node", { ok: true, nodeId: a.id, note: "exchange?" }), "applied: Added a note on 0x1111…1111");
  assert.equal(say("open_trace_doc", { ok: true, url: "#trace/scratch", persistent: false }), "read: This canvas is local-only: connect a wallet to save it");
  const link = describeToolCall({ tool: "open_trace_doc", args: {}, result: { ok: true, url: "#trace/doc/abc", persistent: true } }, d);
  assert.equal(link.href, "#trace/doc/abc");
  const offsite = describeToolCall({ tool: "open_trace_doc", args: {}, result: { ok: true, url: "https://elsewhere.example/", persistent: true } }, d);
  assert.equal(offsite.href, undefined, "only in-app links are ever made clickable");
});
