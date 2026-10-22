import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { User } from "@osstrace/contract";
import type { Db } from "../db/index.ts";
import { nowIso } from "../lib/time.ts";
import type { Config } from "../config.ts";

export const SESSION_COOKIE = "osstrace_session";
export const SESSION_TTL_MS = 30 * 86400_000;
/** last_seen / expiry are only rewritten when older than this (keeps reads cheap). */
const TOUCH_EVERY_MS = 5 * 60_000;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export type SessionUser = User & { sessionId: string };

type UserRow = { id: string; username: string; display_name: string; created_at: string; chain: string | null; wallet_address: string | null };
export const toUser = (r: UserRow): User => ({
  id: r.id,
  username: r.username,
  displayName: r.display_name,
  createdAt: r.created_at,
  chain: r.chain as User["chain"],
  walletAddress: r.wallet_address,
});

export function createSession(db: Db, userId: string, userAgent: string | null): { id: string; token: string } {
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const now = nowIso();
  db.run(
    "INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)",
    id,
    userId,
    sha256(token),
    now,
    now,
    new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    userAgent ? userAgent.slice(0, 300) : null,
  );
  return { id, token };
}

/** Resolves a session token. Returns null when unknown/expired. `slid` = expiry was extended (re-send cookie). */
export function resolveSession(db: Db, token: string): { user: SessionUser; slid: boolean } | null {
  if (!token || token.length > 100) return null;
  const row = db.get<UserRow & { sid: string; last_seen_at: string; expires_at: string }>(
    `SELECT s.id AS sid, s.last_seen_at, s.expires_at, u.id, u.username, u.display_name, u.created_at, u.chain, u.wallet_address
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    sha256(token),
  );
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    db.run("DELETE FROM sessions WHERE id = ?", row.sid);
    return null;
  }
  let slid = false;
  if (Date.now() - Date.parse(row.last_seen_at) > TOUCH_EVERY_MS) {
    db.run("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?", nowIso(), new Date(Date.now() + SESSION_TTL_MS).toISOString(), row.sid);
    slid = true;
  }
  return { user: { ...toUser(row), sessionId: row.sid }, slid };
}

export function pruneSessions(db: Db) {
  db.run("DELETE FROM sessions WHERE expires_at < ?", new Date().toISOString());
}

export function cookieOpts(config: Pick<Config, "cookieSecure">) {
  return { path: "/", httpOnly: true, sameSite: "lax" as const, secure: config.cookieSecure, maxAge: Math.floor(SESSION_TTL_MS / 1000) };
}
