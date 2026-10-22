import { randomUUID } from "node:crypto";
import type { Db } from "../db/index.ts";
import { ApiErr } from "../lib/errors.ts";
import { msToIso, nowIso } from "../lib/time.ts";

const WINDOW_MS = 15 * 60_000;
const FREE_FAILS_PER_USER = 5;
const MAX_FAILS_PER_IP = 50;
const MAX_LOCK_SEC = 15 * 60;

/**
 * Login throttling backed by `login_attempts`:
 * - per (ip, username): the first 5 failures in 15 min are free; after that each further attempt must wait
 *   30 s * 2^(n-5) since the last failure (capped at 15 min);
 * - per ip: more than 50 failures in 15 min blocks the ip until the window rolls.
 */
export function checkLoginAllowed(db: Db, ip: string, username: string, now = Date.now()) {
  const since = msToIso(now - WINDOW_MS);
  const perUser = db.get<{ n: number; last: string | null }>(
    "SELECT COUNT(*) AS n, MAX(at) AS last FROM login_attempts WHERE ip = ? AND username = ? AND success = 0 AND at > ?",
    ip,
    username,
    since,
  )!;
  const n = Number(perUser.n);
  if (n >= FREE_FAILS_PER_USER && perUser.last) {
    const wait = Math.min(MAX_LOCK_SEC, 30 * 2 ** (n - FREE_FAILS_PER_USER));
    const until = Date.parse(perUser.last) + wait * 1000;
    if (until > now) throw tooMany(Math.ceil((until - now) / 1000));
  }
  const perIp = db.get<{ n: number; first: string | null }>(
    "SELECT COUNT(*) AS n, MIN(at) AS first FROM login_attempts WHERE ip = ? AND success = 0 AND at > ?",
    ip,
    since,
  )!;
  if (Number(perIp.n) >= MAX_FAILS_PER_IP && perIp.first) {
    throw tooMany(Math.max(1, Math.ceil((Date.parse(perIp.first) + WINDOW_MS - now) / 1000)));
  }
}

export function recordLogin(db: Db, ip: string, username: string, success: boolean) {
  if (success) {
    db.run("DELETE FROM login_attempts WHERE ip = ? AND username = ? AND success = 0", ip, username);
    return;
  }
  db.run("INSERT INTO login_attempts (id, ip, username, success, at) VALUES (?, ?, ?, 0, ?)", randomUUID(), ip, username, nowIso());
}

/** Signups per ip: at most 10 per hour. */
export function checkSignupAllowed(db: Db, ip: string) {
  const since = msToIso(Date.now() - 3600_000);
  const r = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND username = '__signup__' AND at > ?", ip, since)!;
  if (Number(r.n) >= 10) throw tooMany(600);
  db.run("INSERT INTO login_attempts (id, ip, username, success, at) VALUES (?, ?, '__signup__', 1, ?)", randomUUID(), ip, nowIso());
}

export function pruneAttempts(db: Db) {
  db.run("DELETE FROM login_attempts WHERE at < ?", msToIso(Date.now() - 86400_000));
}

function tooMany(retryAfterSec: number) {
  return new ApiErr("rate_limited", `Too many attempts. Try again in ${retryAfterSec} s.`, { retryAfterSec });
}
