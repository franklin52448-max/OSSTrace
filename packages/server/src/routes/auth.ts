import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthResponse, ChallengeResponse, SessionInfo } from "@osstrace/contract";
import { requireUser, type Ctx } from "../context.ts";
import { ApiErr, conflict, notFound } from "../lib/errors.ts";
import { nowIso } from "../lib/time.ts";
import { parse, walletAddress, walletSignature } from "../schemas.ts";
import { cookieOpts, createSession, SESSION_COOKIE, toUser } from "../auth/sessions.ts";
import { createChallenge, isValidAddress, normalizeAddress, verifyChallenge, type WalletChain } from "../auth/wallet.ts";
import { checkChallengeAllowed, checkVerifyAllowed, recordVerify } from "../auth/throttle.ts";

const walletChain = z.enum(["solana", "ethereum"]);
const challengeBody = z.object({ chain: walletChain, address: walletAddress });
const verifyBody = z.object({ chain: walletChain, address: walletAddress, signature: walletSignature });

type UserRow = { id: string; username: string; display_name: string; created_at: string; chain: string | null; wallet_address: string | null };

/** `sol_AbCdWxYz` / `eth_1234abcd` -- short, readable, and (bar an astronomically unlikely collision) stable per wallet. */
function shortHandle(chain: WalletChain, address: string): string {
  const tag = chain === "solana" ? "sol" : "eth";
  const head = address.slice(0, 4);
  const tail = address.slice(-4);
  return `${tag}_${head}${tail}`;
}

export function registerAuth(app: FastifyInstance, ctx: Ctx) {
  const { db, config } = ctx;

  app.post("/api/auth/challenge", async (req) => {
    // Skipped under the same test-only flag the alerts test-tick route gates on (SERVER_TEST_HOOKS=1,
    // always off in production) -- without it, a test suite doing many real logins from one IP trips
    // the same per-IP abuse guard real callers are meant to.
    if (!config.testHooks) checkChallengeAllowed(db, req.ip);
    const body = parse(challengeBody, req.body);
    if (!isValidAddress(body.chain, body.address)) throw new ApiErr("bad_request", `That doesn't look like a ${body.chain} address`);
    // Already validated by the CSRF check in app.ts's onRequest hook (same Origin-or-Referer logic,
    // repeated here since that hook only validates, it doesn't normalize req.headers.origin itself).
    let origin = req.headers.origin;
    if (!origin && req.headers.referer) {
      try {
        origin = new URL(req.headers.referer).origin;
      } catch {
        origin = undefined;
      }
    }
    if (!origin) origin = `https://${req.headers.host}`;
    const message = createChallenge(body.chain, body.address, origin);
    const res: ChallengeResponse = { message };
    return res;
  });

  app.post("/api/auth/verify", async (req, reply) => {
    const body = parse(verifyBody, req.body);
    const normalized = normalizeAddress(body.chain, body.address);
    const walletKey = `${body.chain}:${normalized}`;
    if (!config.testHooks) checkVerifyAllowed(db, req.ip, walletKey);
    const ok = isValidAddress(body.chain, body.address) && verifyChallenge(body.chain, body.address, body.signature);
    if (!ok) {
      recordVerify(db, req.ip, walletKey, false);
      throw new ApiErr("unauthorized", "Signature didn't verify, or the sign-in request expired -- try again");
    }
    recordVerify(db, req.ip, walletKey, true);

    let row = db.get<UserRow>("SELECT id, username, display_name, created_at, chain, wallet_address FROM users WHERE chain = ? AND wallet_address = ?", body.chain, normalized);
    if (!row) {
      if (!ctx.config.allowSignup) throw new ApiErr("forbidden", "New sign-ups are disabled on this server");
      const id = randomUUID();
      const now = nowIso();
      const handle = shortHandle(body.chain, body.address);
      let uname = handle;
      for (let i = 1; db.get("SELECT 1 FROM users WHERE username = ?", uname); i++) uname = `${handle}_${i}`;
      try {
        db.tx(() => {
          db.run(
            "INSERT INTO users (id, username, display_name, created_at, updated_at, chain, wallet_address) VALUES (?, ?, ?, ?, ?, ?, ?)",
            id,
            uname,
            handle,
            now,
            now,
            body.chain,
            normalized,
          );
          db.run(
            "INSERT INTO notification_methods (id, user_id, kind, name, url, secret, enabled, created_at) VALUES (?, ?, 'in_app', 'In-app inbox', NULL, NULL, 1, ?)",
            randomUUID(),
            id,
            now,
          );
        });
      } catch (e) {
        if (String(e).includes("UNIQUE")) throw conflict("That wallet is already registered");
        throw e;
      }
      row = { id, username: uname, display_name: handle, created_at: now, chain: body.chain, wallet_address: normalized };
    }

    const s = createSession(db, row.id, req.headers["user-agent"] ?? null);
    reply.setCookie(SESSION_COOKIE, s.token, cookieOpts(ctx.config));
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
    const res: AuthResponse = { user: { id: u.id, username: u.username, displayName: u.displayName, createdAt: u.createdAt, chain: u.chain, walletAddress: u.walletAddress } };
    return res;
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
    // No re-auth step needed: the wallet signature that started this session already proved
    // ownership, and there's no password to re-check (unlike the old username+password flow).
    const u = requireUser(req);
    // Every user-owned table cascades from users(id).
    db.run("DELETE FROM users WHERE id = ?", u.id);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.status(204).send();
  });
}
