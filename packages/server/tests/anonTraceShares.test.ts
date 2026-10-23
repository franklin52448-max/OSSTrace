import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addressNodeId } from "@osstrace/contract";
import { Client, makeApp, type TestApp } from "./helpers.ts";

const doc = (traceId = "scratch") => ({
  title: "my scratch trace",
  notes: "",
  nodes: [
    {
      id: addressNodeId(traceId, "ethereum", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"),
      kind: "address" as const,
      chain: "ethereum" as const,
      address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      currentPosition: { x: 0, y: 0 },
    },
  ],
  edges: [],
});

describe("anon trace shares (ADR 0025)", () => {
  let t: TestApp;
  let anon: Client;

  beforeEach(async () => {
    t = await makeApp();
    anon = new Client(t.app); // no signup() -- these routes take no session at all
  });
  afterEach(async () => t.close());

  it("creates a share with no account and no requireUser, returns a real id and a 3-hour expiry", async () => {
    const before = Date.now();
    const r = await anon.post("/api/anon-traces", doc());
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(10);
    const expiresAt = Date.parse(body.expiresAt);
    expect(expiresAt).toBeGreaterThan(before + 2.9 * 3600_000);
    expect(expiresAt).toBeLessThan(before + 3.1 * 3600_000);
  });

  it("the created share is readable by a second, still-unauthenticated caller", async () => {
    const created = (await anon.post("/api/anon-traces", doc())).json();
    const reader = new Client(t.app);
    const r = await reader.get(`/api/anon-traces/${created.id}`);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.title).toBe("my scratch trace");
    expect(body.nodes).toHaveLength(1);
    expect(body.isOwner).toBe(false);
    expect(body.shareable).toBe(true);
  });

  it("stamps createdAt on nodes/edges that omitted it, the same way a real trace's reducer would", async () => {
    const created = (await anon.post("/api/anon-traces", doc())).json();
    const r = await anon.get(`/api/anon-traces/${created.id}`);
    expect(typeof r.json().nodes[0].createdAt).toBe("string");
  });

  it("404s a share id that was never created", async () => {
    const r = await anon.get("/api/anon-traces/00000000-0000-0000-0000-000000000000");
    expect(r.statusCode).toBe(404);
  });

  it("404s an expired share instead of serving a stale snapshot", async () => {
    const created = (await anon.post("/api/anon-traces", doc())).json();
    // Backdate it directly rather than mocking global time -- this codebase has no existing
    // clock-mocking convention, and the expiry check itself is a plain string comparison against
    // a stored expires_at, so moving that column is a faithful, minimal test of the real logic.
    t.ctx.db.run("UPDATE anon_trace_shares SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), created.id);
    const r = await anon.get(`/api/anon-traces/${created.id}`);
    expect(r.statusCode).toBe(404);
  });

  it("an expired share is gone for good after the prune sweep, not just hidden", async () => {
    const created = (await anon.post("/api/anon-traces", doc())).json();
    t.ctx.db.run("UPDATE anon_trace_shares SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), created.id);
    const before = t.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM anon_trace_shares WHERE id = ?", created.id)!;
    expect(Number(before.n)).toBe(1);
    const { pruneAnonTraceShares } = await import("../src/services/anonTraceShares.ts");
    pruneAnonTraceShares(t.ctx);
    const after = t.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM anon_trace_shares WHERE id = ?", created.id)!;
    expect(Number(after.n)).toBe(0);
  });

  it("rejects a 21st share from the same IP within an hour", async () => {
    for (let i = 0; i < 20; i++) {
      const r = await anon.post("/api/anon-traces", doc());
      expect(r.statusCode).toBe(201);
    }
    const r = await anon.post("/api/anon-traces", doc());
    expect(r.statusCode).toBe(400);
  });

  it("rejects a malformed body (missing required fields) with a real 400, not a 500", async () => {
    const r = await anon.post("/api/anon-traces", { title: "x" });
    expect(r.statusCode).toBe(400);
  });
});
