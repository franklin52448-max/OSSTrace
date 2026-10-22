import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { LabelsResponse } from "@osstrace/contract";
import { requireUser, type Ctx } from "../context.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { nowIso } from "../lib/time.ts";
import { chain, parse, tagColor } from "../schemas.ts";
import type { Param } from "../db/index.ts";
import {
  assertOwnEntity,
  assertOwnTags,
  createLabel,
  DEFAULT_TAG_COLOR,
  exportLabels,
  getEntity,
  getLabel,
  importLabels,
  setEntityTags,
  setLabelTags,
  toEntity,
  toLabels,
  toTag,
} from "../services/labels.ts";

const ids = z.array(z.string().min(1).max(64)).max(50);
const note = z.string().max(2000);
const createLabelBody = z.object({ chain, address: z.string().min(1).max(128), name: z.string().trim().min(1).max(200), note: note.optional(), entityId: z.string().max(64).nullable().optional(), tagIds: ids.optional() }).strict();
const patchLabelBody = z.object({ name: z.string().trim().min(1).max(200).optional(), note: note.nullable().optional(), entityId: z.string().max(64).nullable().optional(), tagIds: ids.optional() }).strict();
const labelsQuery = z.object({
  chain: chain.optional(),
  q: z.string().max(200).optional(),
  entityId: z.string().max(64).optional(),
  tagId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z.string().max(300).optional(),
});
const importBody = z.object({ format: z.enum(["csv", "json"]), data: z.string().max(5_000_000), onConflict: z.enum(["update", "skip"]).default("update") }).strict();
const website = z.string().max(300).regex(/^https?:\/\/\S+$/, "website must be an http(s) URL");
const twitter = z.string().max(64).regex(/^@?[A-Za-z0-9_]{1,30}$/, "twitter must be a handle");
const entityBody = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.string().trim().max(64).optional(),
  note: note.optional(),
  website: website.optional(),
  twitter: twitter.optional(),
  tagIds: ids.optional(),
}).strict();
const entityPatch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  type: z.string().trim().max(64).nullable().optional(),
  note: note.nullable().optional(),
  website: website.nullable().optional(),
  twitter: twitter.nullable().optional(),
  tagIds: ids.optional(),
}).strict();
const tagBody = z.object({ name: z.string().trim().min(1).max(64), color: tagColor.optional() }).strict();
const tagPatch = z.object({ name: z.string().trim().min(1).max(64).optional(), color: tagColor.optional() }).strict();

const like = (s: string) => `%${s.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
const uniqueErr = (e: unknown, msg: string) => {
  if (String(e).includes("UNIQUE")) throw conflict(msg);
  throw e;
};

export function registerLabels(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  // ----- labels -----
  app.get("/api/labels", async (req): Promise<LabelsResponse> => {
    const u = requireUser(req);
    const q = parse(labelsQuery, req.query);
    const conds = ["l.user_id = ?"];
    const params: Param[] = [u.id];
    if (q.chain) conds.push("l.chain = ?"), params.push(q.chain);
    if (q.entityId) conds.push("l.entity_id = ?"), params.push(q.entityId);
    if (q.tagId) conds.push("EXISTS (SELECT 1 FROM label_tags lt WHERE lt.label_id = l.id AND lt.tag_id = ?)"), params.push(q.tagId);
    if (q.q) {
      conds.push("(l.name LIKE ? ESCAPE '\\' OR l.address LIKE ? ESCAPE '\\' OR l.note LIKE ? ESCAPE '\\')");
      params.push(like(q.q), like(q.q), like(q.q));
    }
    const where = conds.join(" AND ");
    const total = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM labels l WHERE ${where}`, ...params)!.n);
    const pageParams = [...params];
    let pageWhere = where;
    if (q.cursor) {
      let c: { c: string; i: string };
      try {
        c = JSON.parse(Buffer.from(q.cursor, "base64url").toString("utf8"));
        if (typeof c.c !== "string" || typeof c.i !== "string") throw new Error();
      } catch {
        throw badRequest("Invalid cursor");
      }
      pageWhere += " AND (l.created_at < ? OR (l.created_at = ? AND l.id < ?))";
      pageParams.push(c.c, c.c, c.i);
    }
    const rows = db.all<{ id: string; created_at: string } & Parameters<typeof toLabels>[1][number]>(
      `SELECT l.* FROM labels l WHERE ${pageWhere} ORDER BY l.created_at DESC, l.id DESC LIMIT ?`,
      ...pageParams,
      q.limit + 1,
    );
    const more = rows.length > q.limit;
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      labels: toLabels(db, page),
      nextCursor: more && last ? Buffer.from(JSON.stringify({ c: last.created_at, i: last.id })).toString("base64url") : null,
      total,
    };
  });

  app.post("/api/labels", async (req, reply) => {
    const u = requireUser(req);
    const b = parse(createLabelBody, req.body);
    const id = createLabel(db, u.id, b);
    return reply.status(201).send(getLabel(db, u.id, id));
  });

  app.patch<{ Params: { id: string } }>("/api/labels/:id", async (req) => {
    const u = requireUser(req);
    const cur = getLabel(db, u.id, req.params.id);
    const b = parse(patchLabelBody, req.body ?? {});
    if (b.entityId !== undefined) assertOwnEntity(db, u.id, b.entityId);
    if (b.tagIds) assertOwnTags(db, u.id, b.tagIds);
    db.tx(() => {
      db.run(
        "UPDATE labels SET name = ?, note = ?, entity_id = ?, updated_at = ? WHERE id = ?",
        b.name ?? cur.name,
        b.note === undefined ? cur.note : b.note,
        b.entityId === undefined ? cur.entityId : b.entityId,
        nowIso(),
        cur.id,
      );
      if (b.tagIds) setLabelTags(db, cur.id, b.tagIds);
    });
    return getLabel(db, u.id, cur.id);
  });

  app.delete<{ Params: { id: string } }>("/api/labels/:id", async (req, reply) => {
    const u = requireUser(req);
    const r = db.run("DELETE FROM labels WHERE id = ? AND user_id = ?", req.params.id, u.id);
    if (r.changes === 0) throw notFound("Label not found");
    return reply.status(204).send();
  });

  app.post("/api/labels/import", async (req) => {
    const u = requireUser(req);
    const b = parse(importBody, req.body);
    return importLabels(db, u.id, b.format, b.data, b.onConflict);
  });

  app.get("/api/labels/export", async (req, reply) => {
    const u = requireUser(req);
    const { format } = parse(z.object({ format: z.enum(["csv", "json"]).default("csv") }), req.query);
    const body = exportLabels(db, u.id, format);
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    reply.header("content-type", format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="osstrace-labels-${date}.${format}"`);
    return reply.send(body);
  });

  // ----- entities -----
  app.get("/api/entities", async (req) => {
    const u = requireUser(req);
    const { q } = parse(z.object({ q: z.string().max(200).optional() }), req.query);
    const rows = db.all<Parameters<typeof toEntity>[1]>(
      `SELECT e.*, (SELECT COUNT(*) FROM labels l WHERE l.entity_id = e.id) AS n FROM entities e
       WHERE e.user_id = ? ${q ? "AND e.name LIKE ? ESCAPE '\\'" : ""} ORDER BY e.name`,
      u.id,
      ...(q ? [like(q)] : []),
    );
    return rows.map((r) => toEntity(db, r));
  });

  app.post("/api/entities", async (req, reply) => {
    const u = requireUser(req);
    const b = parse(entityBody, req.body);
    assertOwnTags(db, u.id, b.tagIds ?? []);
    const id = randomUUID();
    const now = nowIso();
    try {
      db.tx(() => {
        db.run(
          "INSERT INTO entities (id, user_id, name, name_key, type, note, website, twitter, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          id,
          u.id,
          b.name,
          b.name.toLowerCase(),
          b.type || null,
          b.note ?? null,
          b.website ?? null,
          b.twitter ?? null,
          now,
          now,
        );
        setEntityTags(db, id, b.tagIds ?? []);
      });
    } catch (e) {
      uniqueErr(e, "An entity with this name already exists");
    }
    return reply.status(201).send(getEntity(db, u.id, id));
  });

  app.get<{ Params: { id: string } }>("/api/entities/:id", async (req) => {
    const u = requireUser(req);
    const e = getEntity(db, u.id, req.params.id);
    const rows = db.all<Parameters<typeof toLabels>[1][number]>("SELECT * FROM labels WHERE user_id = ? AND entity_id = ? ORDER BY chain, address", u.id, e.id);
    return { ...e, addresses: toLabels(db, rows) };
  });

  app.patch<{ Params: { id: string } }>("/api/entities/:id", async (req) => {
    const u = requireUser(req);
    const cur = getEntity(db, u.id, req.params.id);
    const b = parse(entityPatch, req.body ?? {});
    if (b.tagIds) assertOwnTags(db, u.id, b.tagIds);
    try {
      db.tx(() => {
        const name = b.name ?? cur.name;
        db.run(
          "UPDATE entities SET name = ?, name_key = ?, type = ?, note = ?, website = ?, twitter = ?, updated_at = ? WHERE id = ?",
          name,
          name.toLowerCase(),
          b.type === undefined ? cur.type : b.type || null,
          b.note === undefined ? cur.note : b.note,
          b.website === undefined ? cur.website : b.website,
          b.twitter === undefined ? cur.twitter : b.twitter,
          nowIso(),
          cur.id,
        );
        if (b.tagIds) setEntityTags(db, cur.id, b.tagIds);
      });
    } catch (e) {
      uniqueErr(e, "An entity with this name already exists");
    }
    return getEntity(db, u.id, cur.id);
  });

  app.delete<{ Params: { id: string } }>("/api/entities/:id", async (req, reply) => {
    const u = requireUser(req);
    const e = getEntity(db, u.id, req.params.id);
    // Labels are detached (FK ON DELETE SET NULL), never deleted.
    db.run("DELETE FROM entities WHERE id = ?", e.id);
    return reply.status(204).send();
  });

  // ----- tags -----
  const tagRows = (userId: string, id?: string) =>
    db.all<{ id: string; name: string; color: string; created_at: string; n: number }>(
      `SELECT t.id, t.name, t.color, t.created_at,
         (SELECT COUNT(*) FROM label_tags lt WHERE lt.tag_id = t.id) + (SELECT COUNT(*) FROM entity_tags et WHERE et.tag_id = t.id) AS n
       FROM tags t WHERE t.user_id = ? ${id ? "AND t.id = ?" : ""} ORDER BY t.name`,
      userId,
      ...(id ? [id] : []),
    );
  const oneTag = (userId: string, id: string) => {
    const r = tagRows(userId, id)[0];
    if (!r) throw notFound("Tag not found");
    return toTag(r);
  };

  app.get("/api/tags", async (req) => tagRows(requireUser(req).id).map(toTag));

  app.post("/api/tags", async (req, reply) => {
    const u = requireUser(req);
    const b = parse(tagBody, req.body);
    const id = randomUUID();
    try {
      db.run("INSERT INTO tags (id, user_id, name, name_key, color, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, u.id, b.name, b.name.toLowerCase(), b.color ?? DEFAULT_TAG_COLOR, nowIso());
    } catch (e) {
      uniqueErr(e, "A tag with this name already exists");
    }
    return reply.status(201).send(oneTag(u.id, id));
  });

  app.patch<{ Params: { id: string } }>("/api/tags/:id", async (req) => {
    const u = requireUser(req);
    const cur = oneTag(u.id, req.params.id);
    const b = parse(tagPatch, req.body ?? {});
    const name = b.name ?? cur.name;
    try {
      db.run("UPDATE tags SET name = ?, name_key = ?, color = ? WHERE id = ?", name, name.toLowerCase(), b.color ?? cur.color, cur.id);
    } catch (e) {
      uniqueErr(e, "A tag with this name already exists");
    }
    return oneTag(u.id, cur.id);
  });

  app.delete<{ Params: { id: string } }>("/api/tags/:id", async (req, reply) => {
    const u = requireUser(req);
    const r = db.run("DELETE FROM tags WHERE id = ? AND user_id = ?", req.params.id, u.id);
    if (r.changes === 0) throw notFound("Tag not found");
    return reply.status(204).send();
  });
}
