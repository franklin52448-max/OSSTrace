import { createHmac, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { NotificationMethod, Preferences, Settings, WebhookTestResult } from "@osstrace/contract";
import { requireUser, type Ctx } from "../context.ts";
import { ApiErr, badRequest, notFound } from "../lib/errors.ts";
import { assertPublicUrl, SsrfError } from "../lib/ssrf.ts";
import { nowIso } from "../lib/time.ts";
import { displayName, parse, preferences } from "../schemas.ts";
import { toUser } from "../auth/sessions.ts";

export const DEFAULT_PREFS: Preferences = {
  theme: "dark",
  defaultChain: "ethereum",
  defaultUsdGte: 1,
  defaultTimeLast: "30d",
  flowDots: true,
  timezone: "UTC",
};

const updateBody = z.object({ displayName: displayName.optional(), preferences: preferences.partial().optional() }).strict();
const createMethod = z.object({ kind: z.literal("webhook"), name: z.string().trim().min(1).max(64), url: z.string().max(2048), secret: z.string().min(8).max(256).optional() }).strict();
const patchMethod = z.object({ name: z.string().trim().min(1).max(64).optional(), enabled: z.boolean().optional(), url: z.string().max(2048).optional() }).strict();

type MethodRow = { id: string; kind: "webhook" | "in_app"; name: string; url: string | null; secret: string | null; enabled: number; created_at: string; last_status: string | null };

export const toMethod = (r: MethodRow): NotificationMethod =>
  r.kind === "webhook"
    ? { id: r.id, kind: "webhook", name: r.name, url: r.url ?? "", enabled: r.enabled === 1, createdAt: r.created_at, lastStatus: r.last_status }
    : { id: r.id, kind: "in_app", name: r.name, enabled: r.enabled === 1, createdAt: r.created_at };

export function loadPrefs(ctx: Ctx, userId: string): Preferences {
  const r = ctx.db.get<{ prefs_json: string }>("SELECT prefs_json FROM user_prefs WHERE user_id = ?", userId);
  if (!r) return { ...DEFAULT_PREFS };
  const stored = preferences.partial().safeParse(JSON.parse(r.prefs_json));
  // Only keys genuinely present override a default -- never let an explicit `undefined` (which a
  // hand-edited or stale prefs_json row could in principle carry) blank out a required field.
  const patch = stored.success ? Object.fromEntries(Object.entries(stored.data).filter(([, v]) => v !== undefined)) : {};
  return { ...DEFAULT_PREFS, ...patch } as Preferences;
}

/** Signs `${timestamp}.${body}` with HMAC-SHA256 when the method has a secret. */
export function webhookHeaders(secret: string | null, body: string, event: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const h: Record<string, string> = { "x-osstrace-event": event, "x-osstrace-timestamp": ts };
  if (secret) h["x-osstrace-signature"] = "sha256=" + createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return h;
}

async function checkUrl(ctx: Ctx, url: string) {
  try {
    await assertPublicUrl(url, ctx.resolver);
  } catch (e) {
    if (e instanceof SsrfError) throw badRequest(`Webhook URL refused: ${e.message}`);
    throw e;
  }
}

export function registerSettings(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  const settingsOf = (userId: string): Settings => {
    const u = db.get<{ id: string; username: string; display_name: string; created_at: string; chain: string | null; wallet_address: string | null }>(
      "SELECT id, username, display_name, created_at, chain, wallet_address FROM users WHERE id = ?",
      userId,
    )!;
    return { user: toUser(u), preferences: loadPrefs(ctx, userId) };
  };

  app.get("/api/settings", async (req) => settingsOf(requireUser(req).id));

  app.patch("/api/settings", async (req) => {
    const u = requireUser(req);
    const body = parse(updateBody, req.body ?? {});
    const now = nowIso();
    db.tx(() => {
      if (body.displayName) db.run("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?", body.displayName, now, u.id);
      if (body.preferences) {
        const next = { ...loadPrefs(ctx, u.id), ...body.preferences };
        db.run(
          `INSERT INTO user_prefs (user_id, prefs_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (user_id) DO UPDATE SET prefs_json = excluded.prefs_json, updated_at = excluded.updated_at`,
          u.id,
          JSON.stringify(next),
          now,
        );
      }
    });
    return settingsOf(u.id);
  });

  const getMethod = (userId: string, id: string) => {
    const r = db.get<MethodRow>("SELECT * FROM notification_methods WHERE id = ? AND user_id = ?", id, userId);
    if (!r) throw notFound("Notification method not found");
    return r;
  };

  app.get("/api/settings/notification-methods", async (req) => {
    const u = requireUser(req);
    return db.all<MethodRow>("SELECT * FROM notification_methods WHERE user_id = ? ORDER BY kind = 'in_app' DESC, created_at", u.id).map(toMethod);
  });

  app.post("/api/settings/notification-methods", async (req, reply) => {
    const u = requireUser(req);
    const body = parse(createMethod, req.body);
    const count = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notification_methods WHERE user_id = ?", u.id)!;
    if (Number(count.n) >= 20) throw badRequest("At most 20 notification methods");
    await checkUrl(ctx, body.url);
    const id = randomUUID();
    db.run(
      "INSERT INTO notification_methods (id, user_id, kind, name, url, secret, enabled, created_at) VALUES (?, ?, 'webhook', ?, ?, ?, 1, ?)",
      id,
      u.id,
      body.name,
      body.url,
      body.secret ?? null,
      nowIso(),
    );
    return reply.status(201).send(toMethod(getMethod(u.id, id)));
  });

  app.patch<{ Params: { id: string } }>("/api/settings/notification-methods/:id", async (req) => {
    const u = requireUser(req);
    const m = getMethod(u.id, req.params.id);
    const body = parse(patchMethod, req.body ?? {});
    if (body.url !== undefined) {
      if (m.kind !== "webhook") throw badRequest("The in-app method has no URL");
      await checkUrl(ctx, body.url);
    }
    db.run(
      "UPDATE notification_methods SET name = ?, enabled = ?, url = ? WHERE id = ?",
      body.name ?? m.name,
      body.enabled === undefined ? m.enabled : body.enabled ? 1 : 0,
      body.url ?? m.url,
      m.id,
    );
    return toMethod(getMethod(u.id, m.id));
  });

  app.delete<{ Params: { id: string } }>("/api/settings/notification-methods/:id", async (req, reply) => {
    const u = requireUser(req);
    const m = getMethod(u.id, req.params.id);
    if (m.kind === "in_app") throw badRequest("The in-app method cannot be deleted");
    db.run("DELETE FROM notification_methods WHERE id = ?", m.id);
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/settings/notification-methods/:id/test", async (req): Promise<WebhookTestResult> => {
    const u = requireUser(req);
    const m = getMethod(u.id, req.params.id);
    if (m.kind === "in_app") return { ok: true, status: null, detail: "in-app inbox is always available" };
    if (!m.url) throw new ApiErr("bad_request", "Webhook has no URL");
    const body = JSON.stringify({ type: "test", message: "OSSTrace webhook test", sentAt: new Date().toISOString() });
    const r = await ctx.sendWebhook(m.url, body, webhookHeaders(m.secret, body, "test"));
    db.run("UPDATE notification_methods SET last_status = ? WHERE id = ?", `${r.ok ? "ok" : "failed"}: ${r.detail}`.slice(0, 200), m.id);
    return { ok: r.ok, status: r.status, detail: r.detail };
  });
}
