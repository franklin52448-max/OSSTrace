import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addressNodeId, aggregateEdgeId, DEFAULT_VISUALIZER_STATE, transferEdgeId, type Trace, type TraceOp } from "@osstrace/contract";
import { ETH_A, ETH_B, ETH_C, ethTransfer, makeApp, signup, type Client, type TestApp } from "./helpers.ts";

const node = (traceId: string, address: string, x = 0, y = 0) => ({
  id: addressNodeId(traceId, "ethereum", address),
  kind: "address" as const,
  chain: "ethereum" as const,
  address,
  currentPosition: { x, y },
  createdAt: "1999-01-01T00:00:00.000Z",
  displayAddress: { address, chain: "ethereum", label: { id: "fake", name: "client-supplied", source: "x" } },
});

describe("traces", () => {
  let t: TestApp;
  let c: Client;
  let id: string;
  const batch = (ops: TraceOp[] | unknown[]) => c.post(`/api/traces/${id}/batch`, { ops });
  const get = async () => (await c.get(`/api/traces/${id}`)).json() as Trace;

  beforeEach(async () => {
    t = await makeApp();
    c = await signup(t.app, "tracer");
    const r = await c.post("/api/traces", { initialAddress: ETH_A.toLowerCase(), title: "case 1" });
    expect(r.statusCode).toBe(201);
    id = r.json().id;
  });
  afterEach(async () => t.close());

  it("creates the root node with the deterministic id at (0,0)", async () => {
    const tr = await get();
    expect(tr.title).toBe("case 1");
    expect(tr.isOwner).toBe(true);
    expect(tr.nodes).toHaveLength(1);
    expect(tr.nodes[0]).toMatchObject({ id: addressNodeId(id, "ethereum", ETH_A), kind: "address", address: ETH_A, currentPosition: { x: 0, y: 0 }, createdAt: tr.createdAt });
  });

  it("batch is idempotent on replay, overwrites createdAt, re-derives displayAddress, bumps updatedAt monotonically", async () => {
    await c.post("/api/labels", { chain: "ethereum", address: ETH_B, name: "Bob's wallet" });
    const ops = [{ type: "create_node", node: node(id, ETH_B, 300, 0) }, { type: "set_title", title: "renamed" }];
    const first = await batch(ops);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ applied: 2, skipped: 0 });
    const replay = await batch([ops[0]]);
    expect(replay.json()).toMatchObject({ applied: 0, skipped: 1 });
    expect(replay.json().updatedAt).toBe(first.json().updatedAt); // no-op does not bump
    const tr = await get();
    expect(tr.updatedAt).toBe(first.json().updatedAt);
    expect(tr.updatedAt).toMatch(/\.\d{6}Z$/);
    const b = tr.nodes.find((n) => n.address === ETH_B)!;
    expect(b.createdAt).toBe(first.json().updatedAt);
    expect(b.displayAddress?.label?.name).toBe("Bob's wallet");
    expect(b.displayAddress?.label?.source).toBe("user");
    const second = await batch([{ type: "set_notes", notes: "n" }]);
    expect(second.json().updatedAt > first.json().updatedAt).toBe(true);
  });

  it("rejects non-deterministic ids, malformed ops and > 500 ops", async () => {
    const bad = await batch([{ type: "create_node", node: { ...node(id, ETH_B), id: "00000000-0000-4000-8000-000000000000" } }]);
    expect(bad.statusCode).toBe(400);
    expect((await batch([{ type: "teleport" }])).statusCode).toBe(400);
    const many = Array.from({ length: 501 }, () => ({ type: "set_notes", notes: "x" }));
    expect((await batch(many)).statusCode).toBe(400);
    expect((await get()).nodes).toHaveLength(1); // atomic: nothing applied
  });

  it("delete_node cascades to its edges; LWW on positions", async () => {
    const root = addressNodeId(id, "ethereum", ETH_A);
    const nb = node(id, ETH_B, 300, 0);
    const edgeId = aggregateEdgeId(id, root, nb.id);
    await batch([
      { type: "create_node", node: nb },
      { type: "create_edge", edge: { id: edgeId, kind: "aggregate", fromNodeID: root, toNodeID: nb.id, createdAt: "x", aggregate: { cachedUSDIn: 1, cachedTransactionCountIn: 1, cachedUSDOut: 1, cachedTransactionCountOut: 1, cachedAt: "x" } } },
    ]);
    expect((await get()).edges).toHaveLength(1);
    const newer = await batch([{ type: "update_node_position", id: nb.id, position: { x: 10, y: 10 }, clientTimestamp: "2026-10-22T10:00:02.000Z" }]);
    expect(newer.json().applied).toBe(1);
    const older = await batch([{ type: "update_node_position", id: nb.id, position: { x: 99, y: 99 }, clientTimestamp: "2026-10-22T10:00:01.000Z" }]);
    expect(older.json()).toMatchObject({ applied: 0, skipped: 1 });
    expect((await get()).nodes.find((n) => n.id === nb.id)!.currentPosition).toEqual({ x: 10, y: 10 });
    await batch([{ type: "delete_node", id: nb.id }]);
    const tr = await get();
    expect(tr.nodes).toHaveLength(1);
    expect(tr.edges).toHaveLength(0);
    expect(t.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM trace_edges")!.n).toBe(0);
  });

  it("aggregate edges are recomputed from cached transfers (client numbers ignored); refresh + summary agree", async () => {
    const now = Math.floor(Date.now() / 1000);
    t.ctx.store.upsert([
      ethTransfer(ETH_A, ETH_B, now - 100), // out from A
      ethTransfer(ETH_A, ETH_B, now - 90), // out
      ethTransfer(ETH_B, ETH_A, now - 80), // in
      ethTransfer(ETH_C, ETH_A, now - 70), // unrelated pair
    ]);
    await t.ctx.sync.priceAddress("ethereum", ETH_A); // stub prices: 2000 USD per ETH, 1 ETH each
    const root = addressNodeId(id, "ethereum", ETH_A);
    const nb = node(id, ETH_B, 300, 0);
    const edgeId = aggregateEdgeId(id, root, nb.id);
    await batch([
      { type: "create_node", node: nb },
      { type: "create_edge", edge: { id: edgeId, kind: "aggregate", fromNodeID: root, toNodeID: nb.id, createdAt: "x", aggregate: { cachedUSDIn: 999999, cachedTransactionCountIn: 77, cachedUSDOut: 5, cachedTransactionCountOut: 5, cachedAt: "x" } } },
    ]);
    const e = (await get()).edges[0]!;
    expect(e.kind).toBe("aggregate");
    if (e.kind !== "aggregate") return;
    expect(e.aggregate).toMatchObject({ cachedUSDOut: 4000, cachedTransactionCountOut: 2, cachedUSDIn: 2000, cachedTransactionCountIn: 1 });
    const sum = (await c.post(`/api/traces/${id}/aggregate-summary`, { fromNodeID: root, toNodeID: nb.id })).json();
    expect(sum).toMatchObject({ cachedUSDOut: 4000, cachedTransactionCountOut: 2, cachedUSDIn: 2000, cachedTransactionCountIn: 1 });
    expect(sum.sync.state).toBeDefined();
    const ref = await c.post(`/api/traces/${id}/edges/${edgeId}/refresh`);
    expect(ref.statusCode).toBe(200);
    expect(ref.json().aggregate.cachedTransactionCountOut).toBe(2);
    const list = (await c.get("/api/traces")).json();
    expect(list[0]).toMatchObject({ uuid: id, addressCount: 2, entityCount: 0, transferCount: 3 });
  });

  it("transfer edges show the cached transfer, not client data", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tr = ethTransfer(ETH_A, ETH_B, now - 50);
    t.ctx.store.upsert([tr]);
    const root = addressNodeId(id, "ethereum", ETH_A);
    const nb = node(id, ETH_B);
    await batch([
      { type: "create_node", node: nb },
      { type: "create_edge", edge: { id: transferEdgeId(id, "ethereum", tr.id), kind: "transfer", fromNodeID: root, toNodeID: nb.id, chain: "ethereum", transferID: tr.id, createdAt: "x", displayTransfer: { usd: 123456789 } } },
    ]);
    const e = (await get()).edges[0]!;
    expect(e.kind === "transfer" && e.displayTransfer?.amount).toBe("1");
    expect(e.kind === "transfer" && e.displayTransfer?.usd).not.toBe(123456789);
  });

  it("public read only when shareable, with isOwner=false; delete removes everything", async () => {
    expect((await t.app.inject({ method: "GET", url: `/api/public/traces/${id}` })).statusCode).toBe(404);
    await batch([{ type: "set_shareable", shareable: true }]);
    const pub = await t.app.inject({ method: "GET", url: `/api/public/traces/${id}` });
    expect(pub.statusCode).toBe(200);
    expect(pub.json().isOwner).toBe(false);
    expect((await c.del(`/api/traces/${id}`)).statusCode).toBe(204);
    expect((await c.get(`/api/traces/${id}`)).statusCode).toBe(404);
    expect(t.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM trace_nodes")!.n).toBe(0);
  });
});

describe("views", () => {
  let t: TestApp;
  let c: Client;
  beforeEach(async () => {
    t = await makeApp();
    c = await signup(t.app, "viewer");
  });
  afterEach(async () => t.close());

  it("create, per-field LWW batch, idempotent replay, public read, send to tracer", async () => {
    const state = { ...DEFAULT_VISUALIZER_STATE, base: [{ type: "address", value: `ethereum:${ETH_A}`, exclude: false }] };
    const r = await c.post("/api/views", { name: "v1", state });
    expect(r.statusCode).toBe(201);
    const id = r.json().id;
    const ts1 = "2026-10-22T10:00:01.000Z";
    const ts2 = "2026-10-22T10:00:02.000Z";
    const ops = [
      { type: "set_position", nodeID: ETH_B, position: { x: 1.6, y: 2.4 }, clientTimestamp: ts2 },
      { type: "set_name", name: "renamed", clientTimestamp: ts2 },
    ];
    expect((await c.post(`/api/views/${id}/batch`, { ops })).json()).toMatchObject({ applied: 2 });
    const stale = await c.post(`/api/views/${id}/batch`, { ops: [{ type: "set_name", name: "old", clientTimestamp: ts1 }] });
    expect(stale.json()).toMatchObject({ applied: 0, skipped: 1 });
    const v = (await c.get(`/api/views/${id}`)).json();
    expect(v.name).toBe("renamed");
    expect(v.state.positions[ETH_B]).toEqual({ x: 2, y: 2 });
    expect((await c.post(`/api/views/${id}/batch`, { ops: [{ type: "bogus", clientTimestamp: ts2 }] })).statusCode).toBe(400);
    expect((await t.app.inject({ method: "GET", url: `/api/public/views/${id}` })).statusCode).toBe(404);
    await c.post(`/api/views/${id}/batch`, { ops: [{ type: "set_shareable", shareable: true, clientTimestamp: ts2 }] });
    const pub = (await t.app.inject({ method: "GET", url: `/api/public/views/${id}` })).json();
    expect(pub.isOwner).toBe(false);

    const now = Math.floor(Date.now() / 1000);
    t.ctx.store.upsert([ethTransfer(ETH_A, ETH_B, now - 5)]);
    const sent = await c.post(`/api/views/${id}/send-to-tracer`, { nodeIDs: [`ethereum:${ETH_B}`] });
    expect(sent.statusCode).toBe(201);
    const tr = (await c.get(`/api/traces/${sent.json().traceId}`)).json() as Trace;
    expect(tr.nodes.map((n) => n.address)).toEqual([ETH_A, ETH_B]);
    expect(tr.edges).toHaveLength(1);
    expect(tr.edges[0]!.kind === "aggregate" && tr.edges[0]!.aggregate.cachedTransactionCountOut).toBe(1);
    expect((await c.get("/api/views")).json()).toHaveLength(1);
    expect((await c.del(`/api/views/${id}`)).statusCode).toBe(204);
  });
});
