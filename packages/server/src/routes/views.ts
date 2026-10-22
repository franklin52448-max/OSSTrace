import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  addressNodeId,
  aggregateEdgeId,
  applyVisualizerOps,
  entityNodeId,
  type BatchResult,
  type TraceDoc,
  type TraceNode,
  type VisualizerOp,
  type VisualizerState,
  type VisualizerView,
  type VisualizerViewSummary,
} from "@osstrace/contract";
import { requireUser, type Ctx } from "../context.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import { nextAfter, nowIso } from "../lib/time.ts";
import { parse, viewBatch, visualizerState } from "../schemas.ts";
import { computeAggregate, createTrace, loadDoc, nodeAddresses, ownedTrace, saveDoc } from "../services/traces.ts";
import { parseAddrRef, type AddrKey } from "../services/transfers.ts";

type ViewRow = { id: string; user_id: string; name: string; shareable: number; state_json: string; field_ts_json: string; created_at: string; updated_at: string };

const createBody = z.object({ name: z.string().max(256).default(""), state: visualizerState });
const sendBody = z.object({ nodeIDs: z.array(z.string().min(1).max(200)).max(50).optional() });

const toView = (r: ViewRow, isOwner: boolean): VisualizerView => ({
  id: r.id,
  name: r.name,
  shareable: r.shareable === 1,
  isOwner,
  state: JSON.parse(r.state_json) as VisualizerState,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function registerViews(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const owned = (userId: string, id: string) => {
    const r = db.get<ViewRow>("SELECT * FROM views WHERE id = ?", id);
    if (!r || r.user_id !== userId) throw notFound("View not found");
    return r;
  };

  app.post("/api/views", async (req, reply) => {
    const u = requireUser(req);
    const body = parse(createBody, req.body);
    const count = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM views WHERE user_id = ?", u.id)!;
    if (Number(count.n) >= 1000) throw badRequest("View limit reached (1000)");
    const id = randomUUID();
    const now = nowIso();
    db.run(
      "INSERT INTO views (id, user_id, name, shareable, state_json, field_ts_json, created_at, updated_at, version) VALUES (?, ?, ?, 0, ?, '{}', ?, ?, 0)",
      id,
      u.id,
      body.name,
      JSON.stringify(body.state),
      now,
      now,
    );
    return reply.status(201).send({ id });
  });

  app.get("/api/views", async (req) => {
    const u = requireUser(req);
    return db
      .all<ViewRow>("SELECT id, name, shareable, created_at, updated_at FROM views WHERE user_id = ? ORDER BY updated_at DESC", u.id)
      .map((r): VisualizerViewSummary => ({ id: r.id, name: r.name, shareable: r.shareable === 1, createdAt: r.created_at, updatedAt: r.updated_at }));
  });

  app.get<{ Params: { id: string } }>("/api/views/:id", async (req) => toView(owned(requireUser(req).id, req.params.id), true));

  app.delete<{ Params: { id: string } }>("/api/views/:id", async (req, reply) => {
    const r = owned(requireUser(req).id, req.params.id);
    db.run("DELETE FROM views WHERE id = ?", r.id);
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/views/:id/batch", async (req) => {
    const u = requireUser(req);
    owned(u.id, req.params.id);
    const { ops } = parse(viewBatch, req.body);
    const maxTs = new Date(Date.now() + 5000).toISOString();
    const clean = (ops as VisualizerOp[]).map((op) => (op.clientTimestamp > maxTs ? { ...op, clientTimestamp: maxTs } : op));
    return db.tx((): BatchResult => {
      const r = owned(u.id, req.params.id);
      const res = applyVisualizerOps(
        { name: r.name, shareable: r.shareable === 1, state: JSON.parse(r.state_json) as VisualizerState, fieldTs: JSON.parse(r.field_ts_json) as Record<string, string> },
        clean,
      );
      if (res.applied === 0) return { updatedAt: r.updated_at, applied: 0, skipped: res.skipped };
      const updatedAt = nextAfter(r.updated_at);
      db.run(
        "UPDATE views SET name = ?, shareable = ?, state_json = ?, field_ts_json = ?, updated_at = ?, version = version + 1 WHERE id = ?",
        res.doc.name,
        res.doc.shareable ? 1 : 0,
        JSON.stringify(res.doc.state),
        JSON.stringify(res.doc.fieldTs ?? {}),
        updatedAt,
        r.id,
      );
      return { updatedAt, applied: res.applied, skipped: res.skipped };
    });
  });

  app.get<{ Params: { id: string } }>("/api/public/views/:id", async (req) => {
    const r = db.get<ViewRow>("SELECT * FROM views WHERE id = ?", req.params.id);
    if (!r || r.shareable !== 1) throw notFound("View not found");
    return toView(r, false);
  });

  /**
   * Seeds a new trace from the view: one node per non-excluded base, plus (optionally) the given
   * neighbour nodes (`chain:address` or entity ids), each linked to the first base with an aggregate edge
   * computed from cached transfers. Layout: origin at (0,0), neighbours on a 560 px circle.
   */
  app.post<{ Params: { id: string } }>("/api/views/:id/send-to-tracer", async (req, reply) => {
    const u = requireUser(req);
    const v = owned(u.id, req.params.id);
    const body = parse(sendBody, req.body ?? {});
    const state = JSON.parse(v.state_json) as VisualizerState;
    const traceId = createTrace(ctx, u.id, { title: v.name || "From visualizer" }, randomUUID());

    type Seed = { kind: "address"; key: AddrKey } | { kind: "entity"; entityId: string };
    const toSeed = (value: string, type?: "address" | "entity"): Seed | null => {
      if (type === "entity" || (!value.includes(":") && db.get("SELECT 1 FROM entities WHERE id = ? AND user_id = ?", value, u.id))) {
        return db.get("SELECT 1 FROM entities WHERE id = ? AND user_id = ?", value, u.id) ? { kind: "entity", entityId: value } : null;
      }
      try {
        const [k] = parseAddrRef(ctx, u.id, value);
        return k ? { kind: "address", key: k } : null;
      } catch {
        return null;
      }
    };
    const bases = state.base.filter((b) => !b.exclude).map((b) => toSeed(b.value, b.type)).filter((x): x is Seed => !!x);
    const extra = (body.nodeIDs ?? []).map((id) => toSeed(id)).filter((x): x is Seed => !!x);
    const seeds = [...bases, ...extra];
    const now = nowIso();
    const nodeOf = (s: Seed, pos: { x: number; y: number }): TraceNode =>
      s.kind === "address"
        ? { id: addressNodeId(traceId, s.key.chain, s.key.address), kind: "address", chain: s.key.chain, address: s.key.address, currentPosition: pos, createdAt: now }
        : { id: entityNodeId(traceId, s.entityId), kind: "entity", entityID: s.entityId, currentPosition: pos, createdAt: now };

    db.tx(() => {
      const t = ownedTrace(ctx, u.id, traceId);
      const doc: TraceDoc = { ...loadDoc(ctx, t), nodes: [], edges: [] };
      const seen = new Set<string>();
      seeds.forEach((s, i) => {
        const angle = (2 * Math.PI * Math.max(0, i - 1)) / Math.max(1, seeds.length - 1);
        const pos = i === 0 ? { x: 0, y: 0 } : { x: Math.round(560 * Math.cos(angle)), y: Math.round(560 * Math.sin(angle)) };
        const n = nodeOf(s, pos);
        if (seen.has(n.id)) return;
        seen.add(n.id);
        doc.nodes.push(n);
      });
      const origin = doc.nodes[0];
      if (origin) {
        for (const n of doc.nodes.slice(1)) {
          const agg = computeAggregate(ctx, nodeAddresses(ctx, u.id, origin), nodeAddresses(ctx, u.id, n), now);
          if (agg.cachedTransactionCountIn + agg.cachedTransactionCountOut === 0) continue;
          doc.edges.push({ id: aggregateEdgeId(traceId, origin.id, n.id), kind: "aggregate", fromNodeID: origin.id, toNodeID: n.id, createdAt: now, aggregate: agg });
        }
      }
      saveDoc(ctx, t, doc, nextAfter(t.updated_at));
    });
    return reply.status(201).send({ traceId });
  });
}
