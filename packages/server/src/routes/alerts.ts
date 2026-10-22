import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { normalizeAddress, type AlertLimits, type AlertTarget, type Notification } from "@osstrace/contract";
import { requireUser, type Ctx } from "../context.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import { nowIso } from "../lib/time.ts";
import { chain, parse } from "../schemas.ts";
import { canonical } from "../services/labels.ts";
import { LIMITS, toEvents, toRule, type AlertRow } from "../services/alerts.ts";
import type { Param } from "../db/index.ts";

const target = z.discriminatedUnion("type", [
  z.object({ type: z.literal("address"), chain, address: z.string().min(1).max(128) }),
  z.object({ type: z.literal("entity"), entityId: z.string().min(1).max(64) }),
]);
const ruleFields = {
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
  targets: z.array(target).min(1, "at least one target").max(LIMITS.maxTargetsPerRule, `at most ${LIMITS.maxTargetsPerRule} targets`),
  direction: z.enum(["in", "out", "both"]),
  minUsd: z.number().finite().min(0).nullable(),
  tokens: z.array(z.string().min(1).max(128)).max(50).nullable(),
  methodIds: z.array(z.string().min(1).max(64)).max(20),
};
const createBody = z.object({ ...ruleFields, enabled: ruleFields.enabled.default(true), minUsd: ruleFields.minUsd.default(null), tokens: ruleFields.tokens.default(null), methodIds: ruleFields.methodIds.default([]) }).strip();
const patchBody = z.object(ruleFields).partial().strip();
const pageQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(300).optional(), unread: z.string().optional() });

const encode = (c: string, i: string) => Buffer.from(JSON.stringify({ c, i })).toString("base64url");
function decode(s: string): { c: string; i: string } {
  try {
    const v = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (typeof v.c === "string" && typeof v.i === "string") return v;
  } catch {
    /* fallthrough */
  }
  throw badRequest("Invalid cursor");
}

export function registerAlerts(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const owned = (userId: string, id: string) => {
    const r = db.get<AlertRow>("SELECT * FROM alerts WHERE id = ?", id);
    if (!r || r.user_id !== userId) throw notFound("Alert not found");
    return r;
  };

  const cleanTargets = (userId: string, ts: z.infer<typeof target>[]): AlertTarget[] =>
    ts.map((t) => {
      if (t.type === "address") return { type: "address", chain: t.chain, address: canonical(t.chain, t.address) };
      if (!db.get("SELECT 1 FROM entities WHERE id = ? AND user_id = ?", t.entityId, userId)) throw badRequest("Unknown entity id in targets");
      return { type: "entity", entityId: t.entityId };
    });
  const cleanMethods = (userId: string, ids: string[]) => {
    for (const id of ids) if (!db.get("SELECT 1 FROM notification_methods WHERE id = ? AND user_id = ?", id, userId)) throw badRequest("Unknown notification method id");
    return [...new Set(ids)];
  };
  const cleanTokens = (tokens: string[] | null) => (tokens ? [...new Set(tokens.map((t) => (/^0x[0-9a-fA-F]{40}$/.test(t) ? normalizeAddress("ethereum", t) : t.trim())))] : null);
  const writeTargets = (alertId: string, ts: AlertTarget[]) => {
    db.run("DELETE FROM alert_targets WHERE alert_id = ?", alertId);
    ts.forEach((t, i) =>
      db.run(
        "INSERT INTO alert_targets (alert_id, ord, type, chain, address, entity_id) VALUES (?, ?, ?, ?, ?, ?)",
        alertId,
        i,
        t.type,
        t.type === "address" ? t.chain : null,
        t.type === "address" ? t.address : null,
        t.type === "entity" ? t.entityId : null,
      ),
    );
  };

  app.get("/api/alerts/limits", async (req): Promise<AlertLimits> => {
    requireUser(req);
    return { ...LIMITS, pollIntervalSec: ctx.config.alertPollSec };
  });

  app.get("/api/alerts", async (req) => {
    const u = requireUser(req);
    return db.all<AlertRow>("SELECT * FROM alerts WHERE user_id = ? ORDER BY created_at DESC", u.id).map((r) => toRule(ctx, r));
  });

  app.post("/api/alerts", async (req, reply) => {
    const u = requireUser(req);
    const b = parse(createBody, req.body);
    const n = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM alerts WHERE user_id = ?", u.id)!;
    if (Number(n.n) >= LIMITS.maxRules) throw badRequest(`At most ${LIMITS.maxRules} alert rules`);
    const targets = cleanTargets(u.id, b.targets);
    const methods = cleanMethods(u.id, b.methodIds);
    const id = randomUUID();
    const now = nowIso();
    db.tx(() => {
      db.run(
        `INSERT INTO alerts (id, user_id, name, enabled, direction, min_usd, tokens_json, method_ids_json, armed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        u.id,
        b.name,
        b.enabled ? 1 : 0,
        b.direction,
        b.minUsd,
        b.tokens ? JSON.stringify(cleanTokens(b.tokens)) : null,
        JSON.stringify(methods),
        now,
        now,
        now,
      );
      writeTargets(id, targets);
    });
    return reply.status(201).send(toRule(ctx, owned(u.id, id)));
  });

  app.get<{ Params: { id: string } }>("/api/alerts/:id", async (req) => toRule(ctx, owned(requireUser(req).id, req.params.id)));

  app.patch<{ Params: { id: string } }>("/api/alerts/:id", async (req) => {
    const u = requireUser(req);
    const cur = owned(u.id, req.params.id);
    const b = parse(patchBody, req.body ?? {});
    const targets = b.targets ? cleanTargets(u.id, b.targets) : null;
    const methods = b.methodIds ? cleanMethods(u.id, b.methodIds) : null;
    const now = nowIso();
    // Re-arm (no backfill) when the rule is re-enabled or its targets change.
    const rearm = (b.enabled === true && cur.enabled === 0) || targets !== null;
    db.tx(() => {
      db.run(
        `UPDATE alerts SET name = ?, enabled = ?, direction = ?, min_usd = ?, tokens_json = ?, method_ids_json = ?, armed_at = ?, updated_at = ? WHERE id = ?`,
        b.name ?? cur.name,
        b.enabled === undefined ? cur.enabled : b.enabled ? 1 : 0,
        b.direction ?? cur.direction,
        b.minUsd === undefined ? cur.min_usd : b.minUsd,
        b.tokens === undefined ? cur.tokens_json : b.tokens === null ? null : JSON.stringify(cleanTokens(b.tokens)),
        methods ? JSON.stringify(methods) : cur.method_ids_json,
        rearm ? now : cur.armed_at,
        now,
        cur.id,
      );
      if (targets) writeTargets(cur.id, targets);
    });
    return toRule(ctx, owned(u.id, cur.id));
  });

  app.delete<{ Params: { id: string } }>("/api/alerts/:id", async (req, reply) => {
    const r = owned(requireUser(req).id, req.params.id);
    db.run("DELETE FROM alerts WHERE id = ?", r.id);
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>("/api/alerts/:id/events", async (req) => {
    const u = requireUser(req);
    const a = owned(u.id, req.params.id);
    const q = parse(pageQuery, req.query);
    const params: Param[] = [a.id];
    let where = "e.alert_id = ?";
    if (q.cursor) {
      const c = decode(q.cursor);
      where += " AND (e.created_at < ? OR (e.created_at = ? AND e.id < ?))";
      params.push(c.c, c.c, c.i);
    }
    const rows = db.all<{ id: string; alert_id: string; alert_name: string; transfer_json: string; matched_target_json: string; created_at: string }>(
      `SELECT e.id, e.alert_id, a.name AS alert_name, e.transfer_json, e.matched_target_json, e.created_at
       FROM alert_events e JOIN alerts a ON a.id = e.alert_id WHERE ${where} ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
      ...params,
      q.limit + 1,
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { events: toEvents(ctx, u.id, page), nextCursor: rows.length > q.limit && last ? encode(last.created_at, last.id) : null };
  });

  app.get("/api/notifications", async (req) => {
    const u = requireUser(req);
    const q = parse(pageQuery, req.query);
    const params: Param[] = [u.id];
    let where = "n.user_id = ?";
    if (q.unread === "1" || q.unread === "true") where += " AND n.read_at IS NULL";
    if (q.cursor) {
      const c = decode(q.cursor);
      where += " AND (n.created_at < ? OR (n.created_at = ? AND n.id < ?))";
      params.push(c.c, c.c, c.i);
    }
    const rows = db.all<{ id: string; event_id: string; created_at: string; read_at: string | null; alert_id: string; alert_name: string; transfer_json: string; matched_target_json: string }>(
      `SELECT n.id, n.event_id, n.created_at, n.read_at, e.alert_id, a.name AS alert_name, e.transfer_json, e.matched_target_json
       FROM notifications n JOIN alert_events e ON e.id = n.event_id JOIN alerts a ON a.id = e.alert_id
       WHERE ${where} ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
      ...params,
      q.limit + 1,
    );
    const page = rows.slice(0, q.limit);
    const events = toEvents(
      ctx,
      u.id,
      page.map((r) => ({ id: r.event_id, alert_id: r.alert_id, alert_name: r.alert_name, transfer_json: r.transfer_json, matched_target_json: r.matched_target_json, created_at: r.created_at })),
    );
    const notifications: Notification[] = page.map((r, i) => ({
      id: r.id,
      eventId: r.event_id,
      alertId: r.alert_id,
      alertName: r.alert_name,
      transfer: events[i]!.transfer,
      createdAt: r.created_at,
      read: r.read_at !== null,
    }));
    const last = page[page.length - 1];
    const unread = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL", u.id)!;
    return { notifications, nextCursor: rows.length > q.limit && last ? encode(last.created_at, last.id) : null, unreadCount: Number(unread.n) };
  });

  app.post("/api/notifications/read", async (req, reply) => {
    const u = requireUser(req);
    const b = parse(z.object({ ids: z.array(z.string().max(64)).max(500).optional(), all: z.boolean().optional() }).strict(), req.body ?? {});
    const now = nowIso();
    if (b.all) db.run("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL", now, u.id);
    else if (b.ids?.length) db.tx(() => b.ids!.forEach((id) => db.run("UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL", now, id, u.id)));
    else throw badRequest("Give ids or all: true");
    return reply.status(204).send();
  });
}
