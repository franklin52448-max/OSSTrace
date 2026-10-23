import { randomUUID } from "node:crypto";
import type { Db } from "../db/index.ts";
import { ApiErr } from "../lib/errors.ts";
import { msToIso, nowIso } from "../lib/time.ts";

const WINDOW_MS = 15 * 60_000;
const FREE_FAILS_PER_USER = 5;
const MAX_FAILS_PER_IP = 50;
const MAX_LOCK_SEC = 15 * 60;

/**
 * Verify throttling backed by `login_attempts` (column still named `username`; it now holds the
 * `chain:address` key being verified -- same shape, new meaning, no migration needed for a table
 * that's purely a rolling attempt log with no foreign keys into it):
 * - per (ip, wallet key): the first 5 failures in 15 min are free; after that each further attempt must wait
 *   30 s * 2^(n-5) since the last failure (capped at 15 min);
 * - per ip: more than 50 failures in 15 min blocks the ip until the window rolls.
 */
export function checkVerifyAllowed(db: Db, ip: string, walletKey: string, now = Date.now()) {
  const since = msToIso(now - WINDOW_MS);
  const perUser = db.get<{ n: number; last: string | null }>(
    "SELECT COUNT(*) AS n, MAX(at) AS last FROM login_attempts WHERE ip = ? AND username = ? AND success = 0 AND at > ?",
    ip,
    walletKey,
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

export function recordVerify(db: Db, ip: string, walletKey: string, success: boolean) {
  if (success) {
    db.run("DELETE FROM login_attempts WHERE ip = ? AND username = ? AND success = 0", ip, walletKey);
    return;
  }
  db.run("INSERT INTO login_attempts (id, ip, username, success, at) VALUES (?, ?, ?, 0, ?)", randomUUID(), ip, walletKey, nowIso());
}

/** Challenges per ip: at most 10 per hour (one wallet can of course retry its own verify freely;
 * this just stops mass nonce-minting). There's deliberately no per-address cap: pending challenges
 * are keyed by their own nonce (see auth/wallet.ts), so requesting one for someone else's address
 * can't invalidate theirs -- and a per-address cap counted across all IPs was itself the lockout,
 * since anyone could burn a target wallet's hourly allowance and block its real owner from even
 * getting a challenge. */
export function checkChallengeAllowed(db: Db, ip: string) {
  const since = msToIso(Date.now() - 3600_000);
  const r = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND username = '__challenge__' AND at > ?", ip, since)!;
  if (Number(r.n) >= 10) throw tooMany(600);
  db.run("INSERT INTO login_attempts (id, ip, username, success, at) VALUES (?, ?, '__challenge__', 1, ?)", randomUUID(), ip, nowIso());
}

export function pruneAttempts(db: Db) {
  db.run("DELETE FROM login_attempts WHERE at < ?", msToIso(Date.now() - 86400_000));
}

function tooMany(retryAfterSec: number) {
  return new ApiErr("rate_limited", `Too many attempts. Try again in ${retryAfterSec} s.`, { retryAfterSec });
}
