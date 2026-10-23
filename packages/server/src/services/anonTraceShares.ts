import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { Ctx } from "../context.ts";
import { notFound, badRequest } from "../lib/errors.ts";
import { nowIso } from "../lib/time.ts";
import type { anonTraceDoc } from "../schemas.ts";

/** Loose by design: this is a validated-but-op-shaped snapshot (createdAt/width/etc. optional, the
 *  same way a single op's node/edge payload is), not a strict TraceDoc -- it's stored and handed
 *  back verbatim, never run back through the reducer that needs TraceDoc's stricter guarantees. */
export type AnonTraceDoc = z.infer<typeof anonTraceDoc> & { shareable: true };

const TTL_MS = 3 * 60 * 60 * 1000;
/** Generous enough for real use, low enough that one visitor can't fill the table -- the snapshot
 *  is a one-time publish, not an ongoing feature someone would script. */
const MAX_PER_IP_PER_HOUR = 20;

type Row = { id: string; doc_json: string; created_at: string; expires_at: string };

export function checkAnonShareAllowed(ctx: Ctx, ip: string) {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const r = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM anon_trace_shares WHERE created_ip = ? AND created_at > ?", ip, since)!;
  if (Number(r.n) >= MAX_PER_IP_PER_HOUR) throw badRequest("Too many shared links from this connection recently -- try again later.");
}

/** Immutable snapshot of a local-only (anon) trace. Not owned by anyone, not undo/redo-able, not
 *  the same system as a signed-in trace's permanent `#trace/view/<id>` link (traces.ts) -- this one
 *  expires in 3 hours and is swept for good after that (see pruneAnonTraceShares). */
export function createAnonTraceShare(ctx: Ctx, ip: string, doc: AnonTraceDoc): { id: string; expiresAt: string } {
  checkAnonShareAllowed(ctx, ip);
  const id = randomUUID();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  ctx.db.run(
    "INSERT INTO anon_trace_shares (id, doc_json, created_ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    id,
    JSON.stringify(doc),
    ip,
    now,
    expiresAt,
  );
  return { id, expiresAt };
}

export function getAnonTraceShare(ctx: Ctx, id: string): { doc: AnonTraceDoc; expiresAt: string } {
  const row = ctx.db.get<Row>("SELECT * FROM anon_trace_shares WHERE id = ?", id);
  if (!row || row.expires_at <= nowIso()) throw notFound("This shared link has expired or does not exist.");
  return { doc: JSON.parse(row.doc_json) as AnonTraceDoc, expiresAt: row.expires_at };
}

export function pruneAnonTraceShares(ctx: Ctx) {
  ctx.db.run("DELETE FROM anon_trace_shares WHERE expires_at < ?", nowIso());
}
