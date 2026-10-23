import { randomBytes, randomUUID } from "node:crypto";
import type { Config } from "../../config.ts";
import type { Db } from "../../db/index.ts";
import { sha256 } from "../../auth/sessions.ts";
import { ApiErr } from "../../lib/errors.ts";
import { msToIso, nowIso } from "../../lib/time.ts";

/** Free agent messages an anonymous visitor gets, per browser. Connecting a wallet removes it. */
export const ANON_MESSAGE_LIMIT = 5;
export const ANON_AGENT_COOKIE = "osstrace_agent";
const ANON_TTL_MS = 30 * 86400_000;
const DAY_MS = 86400_000;
const HOUR_MS = 3600_000;

/**
 * The anon limit is per browser (a cookie), so a visitor who clears cookies gets a fresh 5. These
 * two per-ip ceilings are what bound that: at most this many new anon allowances, and this many anon
 * messages in total, per ip per day -- 5 browsers' worth. A shared ip (office, campus NAT) hits it
 * sooner, which is the accepted cost; signing in is the way past it, same as every other anon cap.
 */
const ANON_NEW_SESSIONS_PER_IP_PER_DAY = 5;
const ANON_MESSAGES_PER_IP_PER_DAY = ANON_NEW_SESSIONS_PER_IP_PER_DAY * ANON_MESSAGE_LIMIT;
/** Signed-in callers are unlimited in the product sense, but not unbounded: the same rolling-window
 *  shape as auth/throttle.ts's challenge limiter, per account and per ip. */
const USER_MESSAGES_PER_HOUR = 60;
const IP_MESSAGES_PER_HOUR = 120;

type AnonRow = { token_hash: string; messages_used: number };

export type AnonAllowance = { tokenHash: string; remaining: number; newToken: string | null };

function tooMany(message: string, retryAfterSec?: number) {
  return new ApiErr("rate_limited", message, retryAfterSec !== undefined ? { retryAfterSec } : {});
}

/** Remaining anon messages for this cookie token (no token, or an unknown one, = a full allowance). Read-only. */
export function anonRemaining(db: Db, token: string | undefined): number {
  const row = token && token.length <= 100 ? db.get<AnonRow>("SELECT * FROM tracer_agent_anon_sessions WHERE token_hash = ?", sha256(token)) : undefined;
  return Math.max(0, ANON_MESSAGE_LIMIT - Number(row?.messages_used ?? 0));
}

/**
 * Atomically spends one anon message: finds (or creates) the browser's allowance row, refuses when
 * it's used up or the ip's daily ceiling is reached, then counts the message. Runs before the model
 * is called, so concurrent requests from one browser can't both squeeze past the last message.
 */
export function reserveAnonMessage(db: Db, ip: string, token: string | undefined): AnonAllowance {
  return db.tx((): AnonAllowance => {
    const now = Date.now();
    let row = token && token.length <= 100 ? db.get<AnonRow>("SELECT * FROM tracer_agent_anon_sessions WHERE token_hash = ?", sha256(token)) : undefined;
    let newToken: string | null = null;
    if (row && Number(row.messages_used) >= ANON_MESSAGE_LIMIT) {
      throw tooMany(`You've used all ${ANON_MESSAGE_LIMIT} free Tracer agent messages. Connect a wallet to keep going -- signed-in use is unlimited.`);
    }
    const dayAgo = msToIso(now - DAY_MS);
    const ipMsgs = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tracer_agent_usage WHERE ip = ? AND principal LIKE 'anon:%' AND at > ?", ip, dayAgo)!;
    if (Number(ipMsgs.n) >= ANON_MESSAGES_PER_IP_PER_DAY) {
      throw tooMany("Too many free Tracer agent messages from this connection today. Connect a wallet to keep going.", 3600);
    }
    if (!row) {
      const made = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tracer_agent_anon_sessions WHERE created_ip = ? AND created_at > ?", ip, dayAgo)!;
      if (Number(made.n) >= ANON_NEW_SESSIONS_PER_IP_PER_DAY) {
        throw tooMany("Too many free Tracer agent sessions from this connection today. Connect a wallet to keep going.", 3600);
      }
      newToken = randomBytes(32).toString("base64url");
      const iso = nowIso();
      db.run("INSERT INTO tracer_agent_anon_sessions (token_hash, created_ip, created_at, last_at, messages_used) VALUES (?, ?, ?, ?, 0)", sha256(newToken), ip, iso, iso);
      row = { token_hash: sha256(newToken), messages_used: 0 };
    }
    db.run("UPDATE tracer_agent_anon_sessions SET messages_used = messages_used + 1, last_at = ? WHERE token_hash = ?", nowIso(), row.token_hash);
    db.run("INSERT INTO tracer_agent_usage (id, ip, principal, at) VALUES (?, ?, ?, ?)", randomUUID(), ip, `anon:${row.token_hash}`, nowIso());
    return { tokenHash: row.token_hash, remaining: ANON_MESSAGE_LIMIT - (Number(row.messages_used) + 1), newToken };
  });
}

/** Gives a reserved anon message back -- only when the model provider never answered at all, so a
 *  visitor isn't charged one of five messages for an outage they got nothing from. */
export function refundAnonMessage(db: Db, tokenHash: string) {
  db.tx(() => {
    db.run("UPDATE tracer_agent_anon_sessions SET messages_used = MAX(0, messages_used - 1) WHERE token_hash = ?", tokenHash);
    const last = db.get<{ id: string }>("SELECT id FROM tracer_agent_usage WHERE principal = ? ORDER BY at DESC LIMIT 1", `anon:${tokenHash}`);
    if (last) db.run("DELETE FROM tracer_agent_usage WHERE id = ?", last.id);
  });
}

/** Signed-in abuse limit: rolling hour, per account and per ip. Counts the message when allowed. */
export function reserveUserMessage(db: Db, ip: string, userId: string) {
  db.tx(() => {
    const now = Date.now();
    const hourAgo = msToIso(now - HOUR_MS);
    const retry = (first: string | null) => Math.max(1, Math.ceil(((first ? Date.parse(first) : now) + HOUR_MS - now) / 1000));
    const mine = db.get<{ n: number; first: string | null }>("SELECT COUNT(*) AS n, MIN(at) AS first FROM tracer_agent_usage WHERE principal = ? AND at > ?", `user:${userId}`, hourAgo)!;
    if (Number(mine.n) >= USER_MESSAGES_PER_HOUR) throw tooMany(`Tracer agent limit reached (${USER_MESSAGES_PER_HOUR} messages an hour). Try again in a bit.`, retry(mine.first));
    const fromIp = db.get<{ n: number; first: string | null }>("SELECT COUNT(*) AS n, MIN(at) AS first FROM tracer_agent_usage WHERE ip = ? AND at > ?", ip, hourAgo)!;
    if (Number(fromIp.n) >= IP_MESSAGES_PER_HOUR) throw tooMany("Too many Tracer agent messages from this connection. Try again in a bit.", retry(fromIp.first));
    db.run("INSERT INTO tracer_agent_usage (id, ip, principal, at) VALUES (?, ?, ?, ?)", randomUUID(), ip, `user:${userId}`, nowIso());
  });
}

export function anonCookieOpts(config: Pick<Config, "cookieSecure">) {
  return { path: "/api/tracer-agent", httpOnly: true, sameSite: "lax" as const, secure: config.cookieSecure, maxAge: Math.floor(ANON_TTL_MS / 1000) };
}

/** Hourly housekeeping (main.ts): usage rows past every window, allowances whose cookie has expired, stale conversations. */
export function pruneTracerAgent(db: Db) {
  const now = Date.now();
  db.run("DELETE FROM tracer_agent_usage WHERE at < ?", msToIso(now - 2 * DAY_MS));
  db.run("DELETE FROM tracer_agent_anon_sessions WHERE last_at < ?", msToIso(now - ANON_TTL_MS));
  db.run("DELETE FROM tracer_agent_turns WHERE at < ?", msToIso(now - DAY_MS));
}
