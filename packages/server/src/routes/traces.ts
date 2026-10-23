import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { applyTraceOps, detectChain, isAddressOnChain, normalizeAddress, type AggregateSummaryResponse, type BatchResult, type TraceOp } from "@osstrace/contract";
import { requireUser, type Ctx } from "../context.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import { nextAfter, nowIso } from "../lib/time.ts";
import { anonTraceDoc, chain, parse, traceBatch } from "../schemas.ts";
import {
  computeAggregate,
  createTrace,
  getTraceRow,
  loadDoc,
  nodeAddresses,
  ownedTrace,
  refreshChangedAggregates,
  sanitizeTraceOps,
  saveDoc,
  summaries,
  toTrace,
} from "../services/traces.ts";
import { createAnonTraceShare, getAnonTraceShare } from "../services/anonTraceShares.ts";
import { syncAll } from "../services/transfers.ts";

const createBody = z.object({ initialAddress: z.string().max(128).nullable().optional(), initialChain: chain.nullable().optional(), title: z.string().max(256).optional() });
const aggBody = z.object({ fromNodeID: z.string().min(1).max(128), toNodeID: z.string().min(1).max(128) });

export function registerTraces(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.post("/api/traces", async (req, reply) => {
    const u = requireUser(req);
    const body = parse(createBody, req.body ?? {});
    let root = null;
    if (body.initialAddress) {
      const c = body.initialChain ?? detectChain(body.initialAddress);
      if (!c || !isAddressOnChain(c, body.initialAddress)) throw badRequest("initialAddress is not a valid address for the chain");
      root = { chain: c, address: normalizeAddress(c, body.initialAddress) };
    }
    const count = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM traces WHERE user_id = ?", u.id)!;
    if (Number(count.n) >= 1000) throw badRequest("Trace limit reached (1000)");
    const id = createTrace(ctx, u.id, { title: body.title, root }, randomUUID());
    return reply.status(201).send({ id });
  });

  app.get("/api/traces", async (req) => summaries(ctx, requireUser(req).id));

  app.get<{ Params: { id: string } }>("/api/traces/:id", async (req) => {
    const u = requireUser(req);
    const t = ownedTrace(ctx, u.id, req.params.id);
    return toTrace(ctx, t, loadDoc(ctx, t), true);
  });

  app.delete<{ Params: { id: string } }>("/api/traces/:id", async (req, reply) => {
    const u = requireUser(req);
    const t = ownedTrace(ctx, u.id, req.params.id);
    db.run("DELETE FROM traces WHERE id = ?", t.id);
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/traces/:id/batch", async (req) => {
    const u = requireUser(req);
    ownedTrace(ctx, u.id, req.params.id);
    const { ops } = parse(traceBatch, req.body);
    const placeholder = nowIso();
    const clean = sanitizeTraceOps(req.params.id, ops as TraceOp[], placeholder);
    // One transaction: load -> shared reducer -> recompute aggregates -> persist -> bump updatedAt.
    return db.tx((): BatchResult => {
      const t = ownedTrace(ctx, u.id, req.params.id);
      const before = loadDoc(ctx, t);
      const updatedAt = nextAfter(t.updated_at);
      const stamped = clean.map((op): TraceOp => {
        if (op.type === "create_node") return { ...op, node: { ...op.node, createdAt: updatedAt } };
        if (op.type === "create_edge") return { ...op, edge: { ...op.edge, createdAt: updatedAt } as typeof op.edge };
        return op;
      });
      const r = applyTraceOps(before, stamped);
      refreshChangedAggregates(ctx, t.user_id, before, r.doc, updatedAt);
      if (r.applied > 0) saveDoc(ctx, t, r.doc, updatedAt);
      return { updatedAt: r.applied > 0 ? updatedAt : t.updated_at, applied: r.applied, skipped: r.skipped };
    });
  });

  app.post<{ Params: { id: string } }>("/api/traces/:id/aggregate-summary", async (req) => {
    const u = requireUser(req);
    const t = ownedTrace(ctx, u.id, req.params.id);
    const body = parse(aggBody, req.body);
    const doc = loadDoc(ctx, t);
    const from = doc.nodes.find((n) => n.id === body.fromNodeID);
    const to = doc.nodes.find((n) => n.id === body.toNodeID);
    if (!from || !to) throw notFound("Node not found in this trace");
    const a = nodeAddresses(ctx, t.user_id, from);
    const b = nodeAddresses(ctx, t.user_id, to);
    const sync = await syncAll(ctx, a.length <= b.length ? a : b, null, { maxRounds: 2 });
    const agg = computeAggregate(ctx, a, b, nowIso());
    const res: AggregateSummaryResponse = { ...agg, sync };
    return res;
  });

  app.post<{ Params: { id: string; edgeId: string } }>("/api/traces/:id/edges/:edgeId/refresh", async (req) => {
    const u = requireUser(req);
    const t0 = ownedTrace(ctx, u.id, req.params.id);
    const doc0 = loadDoc(ctx, t0);
    const e0 = doc0.edges.find((e) => e.id === req.params.edgeId);
    if (!e0) throw notFound("Edge not found");
    if (e0.kind !== "aggregate") return toTrace(ctx, t0, { ...doc0, edges: [e0] }, true).edges[0];
    const nodes = new Map(doc0.nodes.map((n) => [n.id, n]));
    const a = nodeAddresses(ctx, t0.user_id, nodes.get(e0.fromNodeID));
    const b = nodeAddresses(ctx, t0.user_id, nodes.get(e0.toNodeID));
    try {
      await syncAll(ctx, a.length <= b.length ? a : b, null, { maxRounds: 1 });
    } catch {
      /* provider down: recompute from what is cached */
    }
    return db.tx(() => {
      const t = ownedTrace(ctx, u.id, req.params.id);
      const doc = loadDoc(ctx, t);
      const idx = doc.edges.findIndex((e) => e.id === req.params.edgeId);
      const e = doc.edges[idx];
      if (!e || e.kind !== "aggregate") throw notFound("Edge not found");
      const updatedAt = nextAfter(t.updated_at);
      const n = new Map(doc.nodes.map((x) => [x.id, x]));
      const agg = computeAggregate(ctx, nodeAddresses(ctx, t.user_id, n.get(e.fromNodeID)), nodeAddresses(ctx, t.user_id, n.get(e.toNodeID)), updatedAt);
      const next = { ...e, aggregate: agg };
      doc.edges[idx] = next;
      saveDoc(ctx, t, doc, updatedAt);
      return next;
    });
  });

  app.get<{ Params: { id: string } }>("/api/public/traces/:id", async (req) => {
    const t = getTraceRow(ctx, req.params.id);
    if (!t || t.shareable !== 1) throw notFound("Trace not found");
    return toTrace(ctx, t, loadDoc(ctx, t), false, { publicRead: true });
  });

  // Anon Tracer sharing (ADR 0025) -- intentionally separate from the routes above: no account,
  // no ownership, a 3-hour-expiring snapshot rather than a live document. Neither route calls
  // requireUser.
  app.post("/api/anon-traces", async (req, reply) => {
    const doc = parse(anonTraceDoc, req.body ?? {});
    const now = nowIso();
    const r = createAnonTraceShare(ctx, req.ip, {
      ...doc,
      shareable: true,
      nodes: doc.nodes.map((n) => ({ ...n, createdAt: n.createdAt ?? now })),
      edges: doc.edges.map((e) => ({ ...e, createdAt: e.createdAt ?? now })),
    });
    return reply.status(201).send(r);
  });

  app.get<{ Params: { id: string } }>("/api/anon-traces/:id", async (req) => {
    const r = getAnonTraceShare(ctx, req.params.id);
    return { title: r.doc.title, notes: r.doc.notes, nodes: r.doc.nodes, edges: r.doc.edges, shareable: true, isOwner: false, expiresAt: r.expiresAt };
  });
}
