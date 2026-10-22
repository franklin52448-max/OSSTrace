import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addressNodeId, entityNodeId, transferEdgeId, type Trace } from "@osstrace/contract";
import { ETH_A, ETH_B, ethTransfer, makeApp, signup, SOL_A, type TestApp } from "./helpers.ts";

describe("public reads never expose the owner's private labels, entities or tags", () => {
  let t: TestApp;
  beforeEach(async () => (t = await makeApp()));
  afterEach(async () => t.close());

  it("shareable trace: anonymous view is label-free, owner still sees labels", async () => {
    const c = await signup(t.app, "sharer");
    const tag = (await c.post("/api/tags", { name: "secret-tag" })).json();
    const ent = (await c.post("/api/entities", { name: "Secret Entity" })).json();
    await c.post("/api/labels", { chain: "ethereum", address: ETH_A, name: "Secret Label A", entityId: ent.id, tagIds: [tag.id] });
    await c.post("/api/labels", { chain: "ethereum", address: ETH_B, name: "Secret Label B" });
    const id = (await c.post("/api/traces", { initialAddress: ETH_A })).json().id;
    const tr = ethTransfer(ETH_A, ETH_B, Math.floor(Date.now() / 1000) - 60);
    t.ctx.store.upsert([tr]);
    const root = addressNodeId(id, "ethereum", ETH_A);
    const nb = addressNodeId(id, "ethereum", ETH_B);
    const ne = entityNodeId(id, ent.id);
    const r = await c.post(`/api/traces/${id}/batch`, {
      ops: [
        { type: "create_node", node: { id: nb, kind: "address", chain: "ethereum", address: ETH_B, currentPosition: { x: 300, y: 0 }, createdAt: "x" } },
        { type: "create_node", node: { id: ne, kind: "entity", entityID: ent.id, currentPosition: { x: 0, y: 300 }, createdAt: "x" } },
        { type: "create_edge", edge: { id: transferEdgeId(id, "ethereum", tr.id), kind: "transfer", fromNodeID: root, toNodeID: nb, chain: "ethereum", transferID: tr.id, createdAt: "x" } },
        { type: "set_shareable", shareable: true },
      ],
    });
    expect(r.json().applied).toBe(4);

    const anon = await t.app.inject({ method: "GET", url: `/api/public/traces/${id}` });
    expect(anon.statusCode).toBe(200);
    expect(anon.body).not.toMatch(/Secret|secret-tag/);
    const pub = anon.json() as Trace;
    for (const n of pub.nodes) {
      if (n.displayAddress) expect(n.displayAddress).toMatchObject({ entity: null, label: null, tags: [] });
      expect(n.displayEntity).toBeUndefined();
    }
    const e = pub.edges[0]!;
    expect(e.kind === "transfer" && e.displayTransfer?.from).toMatchObject({ address: ETH_A, label: null, entity: null, tags: [] });

    // Another signed-in user reading the public URL gets the same label-free view.
    const other = await signup(t.app, "stranger");
    expect((await other.get(`/api/public/traces/${id}`)).body).not.toMatch(/Secret/);

    // The owner's authenticated read is unchanged.
    const mine = (await c.get(`/api/traces/${id}`)).json() as Trace;
    expect(mine.nodes.find((n) => n.id === root)!.displayAddress).toMatchObject({ label: { name: "Secret Label A" }, entity: { name: "Secret Entity" } });
    expect(mine.nodes.find((n) => n.id === ne)!.displayEntity?.name).toBe("Secret Entity");
    const me = mine.edges[0]!;
    expect(me.kind === "transfer" && me.displayTransfer?.to.label?.name).toBe("Secret Label B");
  });

  it("balances report truncation at the cap", async () => {
    const c = await signup(t.app, "rich");
    t.sol.balances = Array.from({ length: 1003 }, (_, i) => ({ tokenId: `Mint${i}`.padEnd(32, "1"), symbol: null, name: null, decimals: 0, amountRaw: "1", priceCoin: null }));
    const r = (await c.get(`/api/address/solana/${SOL_A}/balances`)).json();
    expect(r.balances).toHaveLength(1000);
    expect(r).toMatchObject({ truncated: true, totalTokenCount: 1003 });
    t.sol.balances = t.sol.balances.slice(0, 2);
    expect((await c.get(`/api/address/solana/${SOL_A}/balances`)).json()).toMatchObject({ truncated: false, totalTokenCount: 2 });
  });
});
