import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthResponse, SessionInfo } from "@osstrace/contract";
import { requireUser, type Ctx } from "../context.ts";
import { ApiErr, badRequest, conflict, notFound } from "../lib/errors.ts";
import { nowIso } from "../lib/time.ts";
import { displayName, parse, password, username } from "../schemas.ts";
import { cookieOpts, createSession, SESSION_COOKIE, toUser } from "../auth/sessions.ts";
import { dummyHash, hashPassword, verifyPassword } from "../auth/password.ts";
import { checkLoginAllowed, checkSignupAllowed, recordLogin } from "../auth/throttle.ts";

const signupBody = z.object({ username, password, displayName: displayName.optional() });
const loginBody = z.object({ username: z.string().trim().min(1).max(64).transform((s) => s.toLowerCase()), password: z.string().min(1).max(512) });
const changeBody = z.object({ currentPassword: z.string().min(1).max(512), newPassword: password });
const deleteBody = z.object({ password: z.string().min(1).max(512) });

type UserRow = { id: string; username: string; display_name: string; created_at: string; password_hash: string };

export function registerAuth(app: FastifyInstance, ctx: Ctx) {
  const { db, config } = ctx;

  app.post("/api/auth/signup", async (req, reply) => {
    if (!config.allowSignup) throw new ApiErr("forbidden", "Sign-up is disabled on this server");
    const body = parse(signupBody, req.body);
    checkSignupAllowed(db, req.ip);
    if (db.get("SELECT 1 FROM users WHERE username = ?", body.username)) throw conflict("That username is taken");
    const hash = await hashPassword(body.password);
    const id = randomUUID();
    const now = nowIso();
    try {
      db.tx(() => {
        db.run(
          "INSERT INTO users (id, username, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          id,
          body.username,
          body.displayName ?? body.username,
          hash,
          now,
          now,
        );
        db.run(
          "INSERT INTO notification_methods (id, user_id, kind, name, url, secret, enabled, created_at) VALUES (?, ?, 'in_app', 'In-app inbox', NULL, NULL, 1, ?)",
          randomUUID(),
          id,
          now,
        );
      });
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw conflict("That username is taken");
      throw e;
    }
    const s = createSession(db, id, req.headers["user-agent"] ?? null);
    reply.setCookie(SESSION_COOKIE, s.token, cookieOpts(config));
    const res: AuthResponse = { user: { id, username: body.username, displayName: body.displayName ?? body.username, createdAt: now } };
    return reply.status(201).send(res);
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = parse(loginBody, req.body);
    checkLoginAllowed(db, req.ip, body.username);
    const row = db.get<UserRow>("SELECT id, username, display_name, created_at, password_hash FROM users WHERE username = ?", body.username);
    // Same scrypt cost whether or not the user exists.
    const ok = await verifyPassword(body.password, row?.password_hash ?? (await dummyHash()));
    if (!row || !ok) {
      recordLogin(db, req.ip, body.username, false);
      throw new ApiErr("unauthorized", "Wrong username or password");
    }
    recordLogin(db, req.ip, body.username, true);
    const s = createSession(db, row.id, req.headers["user-agent"] ?? null);
    reply.setCookie(SESSION_COOKIE, s.token, cookieOpts(config));
    const res: AuthResponse = { user: toUser(row) };
    return res;
  });

  app.post("/api/auth/logout", async (req, reply) => {
    if (req.user) db.run("DELETE FROM sessions WHERE id = ?", req.user.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.status(204).send();
  });

  app.get("/api/auth/me", async (req) => {
    const u = requireUser(req);
    const res: AuthResponse = { user: { id: u.id, username: u.username, displayName: u.displayName, createdAt: u.createdAt } };
    return res;
  });

  app.post("/api/auth/change-password", async (req, reply) => {
    const u = requireUser(req);
    const body = parse(changeBody, req.body);
    checkLoginAllowed(db, req.ip, u.username);
    const row = db.get<UserRow>("SELECT password_hash FROM users WHERE id = ?", u.id)!;
    if (!(await verifyPassword(body.currentPassword, row.password_hash))) {
      recordLogin(db, req.ip, u.username, false);
      throw new ApiErr("bad_request", "Current password is wrong");
    }
    if (body.currentPassword === body.newPassword) throw badRequest("New password must differ from the current one");
    const hash = await hashPassword(body.newPassword);
    db.tx(() => {
      db.run("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", hash, nowIso(), u.id);
      db.run("DELETE FROM sessions WHERE user_id = ? AND id <> ?", u.id, u.sessionId);
    });
    return reply.status(204).send();
  });

  app.get("/api/auth/sessions", async (req) => {
    const u = requireUser(req);
    const rows = db.all<{ id: string; created_at: string; last_seen_at: string; user_agent: string | null }>(
      "SELECT id, created_at, last_seen_at, user_agent FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC",
      u.id,
      new Date().toISOString(),
    );
    return rows.map((r): SessionInfo => ({ id: r.id, createdAt: r.created_at, lastSeenAt: r.last_seen_at, userAgent: r.user_agent, current: r.id === u.sessionId }));
  });

  app.delete<{ Params: { id: string } }>("/api/auth/sessions/:id", async (req, reply) => {
    const u = requireUser(req);
    const r = db.run("DELETE FROM sessions WHERE id = ? AND user_id = ?", req.params.id, u.id);
    if (r.changes === 0) throw notFound("Session not found");
    if (req.params.id === u.sessionId) reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.status(204).send();
  });

  app.delete("/api/auth/account", async (req, reply) => {
    const u = requireUser(req);
    const body = parse(deleteBody, req.body);
    checkLoginAllowed(db, req.ip, u.username);
    const row = db.get<UserRow>("SELECT password_hash FROM users WHERE id = ?", u.id)!;
    if (!(await verifyPassword(body.password, row.password_hash))) {
      recordLogin(db, req.ip, u.username, false);
      throw new ApiErr("bad_request", "Password is wrong");
    }
    // Every user-owned table cascades from users(id).
    db.run("DELETE FROM users WHERE id = ?", u.id);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.status(204).send();
  });
}
