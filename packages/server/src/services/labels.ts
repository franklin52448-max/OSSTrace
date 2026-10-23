import { randomUUID } from "node:crypto";
import { parse as parseCsv } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { CHAINS, isAddressOnChain, isChain, normalizeAddress, type Chain, type Entity, type ImportResult, type Label, type Tag } from "@osstrace/contract";
import type { Db } from "../db/index.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { nowIso } from "../lib/time.ts";

export const DEFAULT_TAG_COLOR = "#7c8594";

type LabelRow = { id: string; chain: Chain; address: string; name: string; note: string | null; entity_id: string | null; created_at: string; updated_at: string };
type EntityRow = { id: string; name: string; type: string | null; note: string | null; website: string | null; twitter: string | null; created_at: string; updated_at: string };

export function canonical(chain: Chain, address: string): string {
  const a = address.trim();
  if (!isAddressOnChain(chain, a)) throw badRequest(`Not a valid ${chain} address`);
  return normalizeAddress(chain, a);
}

export function labelTagIds(db: Db, ids: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    for (const r of db.all<{ label_id: string; tag_id: string }>(`SELECT label_id, tag_id FROM label_tags WHERE label_id IN (${part.map(() => "?").join(",")})`, ...part)) {
      out.set(r.label_id, [...(out.get(r.label_id) ?? []), r.tag_id]);
    }
  }
  return out;
}

export function toLabels(db: Db, rows: LabelRow[]): Label[] {
  const tags = labelTagIds(db, rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    chain: r.chain,
    address: r.address,
    name: r.name,
    note: r.note,
    entityId: r.entity_id,
    tagIds: tags.get(r.id) ?? [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function getLabel(db: Db, userId: string, id: string): Label {
  const r = db.get<LabelRow>("SELECT * FROM labels WHERE id = ? AND user_id = ?", id, userId);
  if (!r) throw notFound("Label not found");
  return toLabels(db, [r])[0]!;
}

export function getEntity(db: Db, userId: string, id: string): Entity {
  const r = db.get<EntityRow & { n: number }>(
    "SELECT e.*, (SELECT COUNT(*) FROM labels l WHERE l.entity_id = e.id) AS n FROM entities e WHERE e.id = ? AND e.user_id = ?",
    id,
    userId,
  );
  if (!r) throw notFound("Entity not found");
  return toEntity(db, r);
}

export function toEntity(db: Db, r: EntityRow & { n: number }): Entity {
  const tagIds = db.all<{ tag_id: string }>("SELECT tag_id FROM entity_tags WHERE entity_id = ?", r.id).map((x) => x.tag_id);
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    note: r.note,
    website: r.website,
    twitter: r.twitter,
    tagIds,
    addressCount: Number(r.n),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function toTag(r: { id: string; name: string; color: string; created_at: string; n: number }): Tag {
  return { id: r.id, name: r.name, color: r.color, createdAt: r.created_at, usageCount: Number(r.n) };
}

/** Ensures every id is a tag owned by the user (404-free: unknown ids are a bad request). */
export function assertOwnTags(db: Db, userId: string, ids: string[]) {
  for (const id of ids) if (!db.get("SELECT 1 FROM tags WHERE id = ? AND user_id = ?", id, userId)) throw badRequest("Unknown tag id");
}
export function assertOwnEntity(db: Db, userId: string, id: string | null | undefined) {
  if (id && !db.get("SELECT 1 FROM entities WHERE id = ? AND user_id = ?", id, userId)) throw badRequest("Unknown entity id");
}

export function setLabelTags(db: Db, labelId: string, tagIds: string[]) {
  db.run("DELETE FROM label_tags WHERE label_id = ?", labelId);
  for (const t of new Set(tagIds)) db.run("INSERT INTO label_tags (label_id, tag_id) VALUES (?, ?)", labelId, t);
}
export function setEntityTags(db: Db, entityId: string, tagIds: string[]) {
  db.run("DELETE FROM entity_tags WHERE entity_id = ?", entityId);
  for (const t of new Set(tagIds)) db.run("INSERT INTO entity_tags (entity_id, tag_id) VALUES (?, ?)", entityId, t);
}

export function createLabel(
  db: Db,
  userId: string,
  b: { chain: Chain; address: string; name: string; note?: string | null | undefined; entityId?: string | null | undefined; tagIds?: string[] | undefined },
): string {
  const address = canonical(b.chain, b.address);
  assertOwnEntity(db, userId, b.entityId);
  assertOwnTags(db, userId, b.tagIds ?? []);
  if (db.get("SELECT 1 FROM labels WHERE user_id = ? AND chain = ? AND address = ?", userId, b.chain, address)) throw conflict("This address already has a label");
  const id = randomUUID();
  const now = nowIso();
  db.tx(() => {
    db.run(
      "INSERT INTO labels (id, user_id, chain, address, name, note, entity_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      userId,
      b.chain,
      address,
      b.name,
      b.note ?? null,
      b.entityId ?? null,
      now,
      now,
    );
    setLabelTags(db, id, b.tagIds ?? []);
  });
  return id;
}

function entityByName(db: Db, userId: string, name: string, create: boolean): string | null {
  const key = name.trim().toLowerCase();
  const r = db.get<{ id: string }>("SELECT id FROM entities WHERE user_id = ? AND name_key = ?", userId, key);
  if (r) return r.id;
  if (!create) return null;
  const id = randomUUID();
  const now = nowIso();
  db.run("INSERT INTO entities (id, user_id, name, name_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", id, userId, name.trim(), key, now, now);
  return id;
}

function tagByName(db: Db, userId: string, name: string): string {
  const key = name.trim().toLowerCase();
  const r = db.get<{ id: string }>("SELECT id FROM tags WHERE user_id = ? AND name_key = ?", userId, key);
  if (r) return r.id;
  const id = randomUUID();
  db.run("INSERT INTO tags (id, user_id, name, name_key, color, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, userId, name.trim(), key, DEFAULT_TAG_COLOR, nowIso());
  return id;
}

/** Spreadsheet formula-injection guard for exported cells (reversed on import). */
const FORMULA = /^[=+\-@\t\r]/;
const guardCell = (s: string) => (FORMULA.test(s) ? `'${s}` : s);
const unguardCell = (s: string) => (s.startsWith("'") && FORMULA.test(s.slice(1)) ? s.slice(1) : s);

type ImportRow = { chain?: unknown; address?: unknown; name?: unknown; note?: unknown; entity?: unknown; tags?: unknown };
const MAX_ROWS = 20_000;

export function importLabels(db: Db, userId: string, format: "csv" | "json", data: string, onConflict: "update" | "skip"): ImportResult {
  let rows: { row: number; r: ImportRow }[];
  if (format === "csv") {
    let records: Record<string, string>[];
    try {
      records = parseCsv(data, { columns: (h: string[]) => h.map((x) => x.trim().toLowerCase()), skip_empty_lines: true, trim: true, bom: true, relax_column_count: true, relax_quotes: true });
    } catch (e) {
      throw badRequest(`CSV could not be parsed: ${(e as Error).message.slice(0, 160)}`);
    }
    if (records.length && !("address" in records[0]! && "chain" in records[0]! && "name" in records[0]!)) {
      throw badRequest("CSV header must include chain,address,name (optional: note,entity,tags)");
    }
    // row = line number in the file (the header is line 1)
    rows = records.map((r, i) => ({ row: i + 2, r }));
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw badRequest("JSON could not be parsed");
    }
    if (!Array.isArray(parsed)) throw badRequest("JSON import must be an array of label objects");
    rows = parsed.map((r, i) => ({ row: i + 1, r: (r && typeof r === "object" ? r : {}) as ImportRow }));
  }
  if (rows.length > MAX_ROWS) throw badRequest(`At most ${MAX_ROWS} rows per import`);

  const result: ImportResult = { created: 0, updated: 0, skipped: [] };
  const str = (v: unknown) => (typeof v === "string" ? unguardCell(v.trim()) : typeof v === "number" ? String(v) : "");
  db.tx(() => {
    for (const { row, r } of rows) {
      const chain = str(r.chain).toLowerCase();
      if (!isChain(chain)) {
        result.skipped.push({ row, reason: `chain must be one of ${CHAINS.join(", ")}` });
        continue;
      }
      const rawAddr = str(r.address);
      if (!isAddressOnChain(chain, rawAddr)) {
        result.skipped.push({ row, reason: `not a valid ${chain} address` });
        continue;
      }
      const address = normalizeAddress(chain, rawAddr);
      const name = str(r.name);
      if (!name || name.length > 200) {
        result.skipped.push({ row, reason: name ? "name longer than 200 characters" : "name is required" });
        continue;
      }
      const note = str(r.note) || null;
      if (note && note.length > 2000) {
        result.skipped.push({ row, reason: "note longer than 2000 characters" });
        continue;
      }
      const entityName = str(r.entity);
      if (entityName.length > 200) {
        result.skipped.push({ row, reason: "entity name longer than 200 characters" });
        continue;
      }
      const tagNames = (Array.isArray(r.tags) ? r.tags.map(str) : str(r.tags).split(";")).map((t) => t.trim()).filter(Boolean);
      if (tagNames.some((t) => t.length > 64) || tagNames.length > 50) {
        result.skipped.push({ row, reason: "too many tags or a tag longer than 64 characters" });
        continue;
      }
      const existing = db.get<LabelRow>("SELECT * FROM labels WHERE user_id = ? AND chain = ? AND address = ?", userId, chain, address);
      if (existing && onConflict === "skip") {
        result.skipped.push({ row, reason: "address already labelled" });
        continue;
      }
      const entityId = entityName ? entityByName(db, userId, entityName, true) : null;
      const tagIds = [...new Set(tagNames.map((t) => tagByName(db, userId, t)))].sort();
      const now = nowIso();
      if (existing) {
        const curTags = (labelTagIds(db, [existing.id]).get(existing.id) ?? []).sort();
        const same = existing.name === name && existing.note === note && existing.entity_id === entityId && curTags.join(",") === tagIds.join(",");
        if (same) {
          result.skipped.push({ row, reason: "unchanged" });
          continue;
        }
        db.run("UPDATE labels SET name = ?, note = ?, entity_id = ?, updated_at = ? WHERE id = ?", name, note, entityId, now, existing.id);
        setLabelTags(db, existing.id, tagIds);
        result.updated++;
      } else {
        const id = randomUUID();
        db.run(
          "INSERT INTO labels (id, user_id, chain, address, name, note, entity_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          id,
          userId,
          chain,
          address,
          name,
          note,
          entityId,
          now,
          now,
        );
        setLabelTags(db, id, tagIds);
        result.created++;
      }
    }
  });
  return result;
}

export function exportLabels(db: Db, userId: string, format: "csv" | "json"): string {
  const rows = db.all<{ id: string; chain: Chain; address: string; name: string; note: string | null; entity: string | null }>(
    `SELECT l.id, l.chain, l.address, l.name, l.note, e.name AS entity FROM labels l LEFT JOIN entities e ON e.id = l.entity_id
     WHERE l.user_id = ? ORDER BY l.chain, l.address`,
    userId,
  );
  const tagNames = new Map<string, string[]>();
  for (const t of db.all<{ label_id: string; name: string }>(
    "SELECT lt.label_id, t.name FROM label_tags lt JOIN tags t ON t.id = lt.tag_id JOIN labels l ON l.id = lt.label_id WHERE l.user_id = ? ORDER BY t.name",
    userId,
  ))
    tagNames.set(t.label_id, [...(tagNames.get(t.label_id) ?? []), t.name]);
  if (format === "json") {
    return JSON.stringify(
      rows.map((r) => ({ chain: r.chain, address: r.address, name: r.name, note: r.note, entity: r.entity, tags: tagNames.get(r.id) ?? [] })),
      null,
      2,
    );
  }
  return stringify(
    rows.map((r) => [r.chain, r.address, guardCell(r.name), guardCell(r.note ?? ""), guardCell(r.entity ?? ""), guardCell((tagNames.get(r.id) ?? []).join(";"))]),
    { header: true, columns: ["chain", "address", "name", "note", "entity", "tags"] },
  );
}
