import { isIPv4, isIPv6 } from "node:net";

/** One sliding-window rule: at most `limit` events per key in any `windowMs`-long stretch of time. */
export interface WindowRule {
  limit: number;
  windowMs: number;
}

export type LimitDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

/**
 * An exact sliding-window ("sliding log") counter, in memory.
 *
 * Each key keeps the timestamps of its counted events inside the window. A key is over its limit
 * when it already holds `limit` timestamps newer than `now - windowMs`; it becomes allowed again
 * the moment the oldest of those ages out, which is exactly the `retryAfterMs` reported. Because
 * an over-limit event is never recorded, a key never holds more than `limit` timestamps, so memory
 * per key is bounded no matter how hard one key is hammered.
 *
 * Memory across keys is bounded too: keys whose events have all aged out are swept every
 * `SWEEP_EVERY` writes, and if more than `maxKeys` live keys exist the oldest-inserted are dropped
 * (fail-open for those keys, never fail-closed for everyone).
 *
 * State lives in this process only and is gone on restart (ADR 0015).
 */
export class SlidingWindowLimiter {
  static readonly SWEEP_EVERY = 1000;

  readonly rule: WindowRule;
  readonly #maxKeys: number;
  readonly #events = new Map<string, number[]>();
  #writesSinceSweep = 0;

  constructor(rule: WindowRule, maxKeys = 50_000) {
    if (!(rule.limit >= 1) || !(rule.windowMs > 0)) throw new Error("rate limit needs limit >= 1 and windowMs > 0");
    this.rule = rule;
    this.#maxKeys = maxKeys;
  }

  /** Would one more event for `key` at `now` be allowed? Does not record anything. */
  check(key: string, now: number): LimitDecision {
    const events = this.#live(key, now);
    if (events.length < this.rule.limit) return { allowed: true };
    // events is sorted ascending; the window frees up when the oldest still-counted event expires.
    const oldest = events[events.length - this.rule.limit] as number;
    return { allowed: false, retryAfterMs: Math.max(1, oldest + this.rule.windowMs - now) };
  }

  /** Records one event for `key` at `now`. Callers check first; recording past the limit is a no-op. */
  record(key: string, now: number): void {
    const events = this.#live(key, now);
    if (events.length >= this.rule.limit) return;
    events.push(now);
    this.#events.delete(key); // re-insert so Map order tracks most-recent write, for eviction below
    this.#events.set(key, events);
    this.#afterWrite(now);
  }

  /** `check` + `record` in one step: counts the event only if it's allowed. */
  hit(key: string, now: number): LimitDecision {
    const decision = this.check(key, now);
    if (decision.allowed) this.record(key, now);
    return decision;
  }

  /** Removes one previously recorded event at exactly `at` (used to un-count a reserved attempt that succeeded). */
  release(key: string, at: number): void {
    const events = this.#events.get(key);
    if (!events) return;
    const index = events.lastIndexOf(at);
    if (index !== -1) events.splice(index, 1);
    if (events.length === 0) this.#events.delete(key);
  }

  /** Forgets every event for `key`. */
  reset(key: string): void {
    this.#events.delete(key);
  }

  /** Number of keys currently tracked (for tests and memory checks). */
  get size(): number {
    return this.#events.size;
  }

  #live(key: string, now: number): number[] {
    const events = this.#events.get(key);
    if (!events) return [];
    const cutoff = now - this.rule.windowMs;
    let firstLive = 0;
    while (firstLive < events.length && (events[firstLive] as number) <= cutoff) firstLive++;
    if (firstLive > 0) events.splice(0, firstLive);
    if (events.length === 0) this.#events.delete(key);
    return events;
  }

  #afterWrite(now: number): void {
    if (++this.#writesSinceSweep >= SlidingWindowLimiter.SWEEP_EVERY || this.#events.size > this.#maxKeys) {
      this.#writesSinceSweep = 0;
      for (const key of [...this.#events.keys()]) this.#live(key, now);
    }
    // Still too many live keys: drop the least recently written ones.
    for (const key of this.#events.keys()) {
      if (this.#events.size <= this.#maxKeys) break;
      this.#events.delete(key);
    }
  }
}

/**
 * The key a caller's IP is limited under. IPv4 (including IPv4-mapped IPv6, `::ffff:1.2.3.4`) is
 * the address itself. IPv6 is its /64 prefix: a single host or customer is routinely handed a
 * whole /64, so limiting per full IPv6 address would let one machine rotate through 2^64 "IPs".
 *
 * This only ever sees the TCP peer (`req.socket.remoteAddress`). Forwarded headers are not read:
 * see ADR 0015 for what that means behind a reverse proxy.
 */
export function ipKey(remoteAddress: string | undefined): string {
  if (!remoteAddress) return "unknown";
  const mapped = remoteAddress.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped?.[1]) return mapped[1];
  if (isIPv4(remoteAddress)) return remoteAddress;
  if (!isIPv6(remoteAddress)) return remoteAddress;
  const groups = expandIPv6(remoteAddress.split("%")[0] as string);
  return `${groups.slice(0, 4).join(":")}::/64`;
}

/** `2001:db8::1` → ["2001","db8","0","0","0","0","0","1"] (lower-case, no leading zeros). */
function expandIPv6(address: string): string[] {
  const [head = "", tail] = address.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  // An embedded IPv4 tail (e.g. `64:ff9b::1.2.3.4`) takes two groups; only the first 4 groups matter here anyway.
  const missing = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(Math.max(0, missing)).fill("0"), ...right].map((g) => g.replace(/^0+(?=.)/, ""));
}

/** Every limit the Accounts HTTP layer enforces. Defaults and their reasoning: ADR 0015. */
export interface AccountsRateLimits {
  /** Failed logins for one email from one IP. Cleared by a successful login for that email from that IP. */
  loginFailuresPerEmailAndIp: WindowRule;
  /** Failed logins for one email from all IPs combined: slows a distributed guess at one account. Not cleared by a success. */
  loginFailuresPerEmail: WindowRule;
  /** Failed logins from one IP across all emails: stops one IP spraying many accounts. Not cleared by a success. */
  loginFailuresPerIp: WindowRule;
  /** Every login request from one IP, whatever the outcome: caps the argon2 work one IP can make us do. */
  loginRequestsPerIp: WindowRule;
  /** Every signup request from one IP, whatever the outcome. */
  signupRequestsPerIp: WindowRule;
}

const MINUTE = 60_000;

export const DEFAULT_ACCOUNTS_RATE_LIMITS: Readonly<AccountsRateLimits> = Object.freeze({
  loginFailuresPerEmailAndIp: { limit: 5, windowMs: 5 * MINUTE },
  loginFailuresPerEmail: { limit: 20, windowMs: 15 * MINUTE },
  loginFailuresPerIp: { limit: 30, windowMs: 5 * MINUTE },
  loginRequestsPerIp: { limit: 60, windowMs: 1 * MINUTE },
  signupRequestsPerIp: { limit: 10, windowMs: 60 * MINUTE },
});

/** A blocked request: which rule tripped and how long until it would be allowed. */
export interface RateLimited {
  limited: true;
  rule: keyof AccountsRateLimits;
  retryAfterMs: number;
}

/** A login attempt that passed the limiters. Settle it exactly once with the outcome. */
export interface LoginAttempt {
  limited: false;
  succeeded(): void;
  failed(): void;
}

/**
 * The login/signup limiters, wired together. Kept apart from the HTTP code so the policy (what
 * counts, what resets what) reads in one place.
 *
 * Login failures are counted *pessimistically*: an attempt reserves a failure slot before the
 * password is checked, and gives it back if the password turns out right. Otherwise a burst of
 * parallel requests would all pass the check while argon2 is still busy with the first one, and
 * "5 failures" would really mean "however many requests fit in one argon2 round-trip".
 */
export class AccountsRateLimiter {
  readonly limits: AccountsRateLimits;
  readonly #now: () => number;
  readonly #emailAndIp: SlidingWindowLimiter;
  readonly #email: SlidingWindowLimiter;
  readonly #ipFailures: SlidingWindowLimiter;
  readonly #ipLogins: SlidingWindowLimiter;
  readonly #ipSignups: SlidingWindowLimiter;

  constructor(limits: Partial<AccountsRateLimits> = {}, now: () => number = Date.now) {
    this.limits = { ...DEFAULT_ACCOUNTS_RATE_LIMITS, ...limits };
    this.#now = now;
    this.#emailAndIp = new SlidingWindowLimiter(this.limits.loginFailuresPerEmailAndIp);
    this.#email = new SlidingWindowLimiter(this.limits.loginFailuresPerEmail);
    this.#ipFailures = new SlidingWindowLimiter(this.limits.loginFailuresPerIp);
    this.#ipLogins = new SlidingWindowLimiter(this.limits.loginRequestsPerIp);
    this.#ipSignups = new SlidingWindowLimiter(this.limits.signupRequestsPerIp);
  }

  /** Counts one signup request from `ip`. Returns the block, or null if it may proceed. */
  signup(ip: string): RateLimited | null {
    const decision = this.#ipSignups.hit(ip, this.#now());
    return decision.allowed ? null : { limited: true, rule: "signupRequestsPerIp", retryAfterMs: decision.retryAfterMs };
  }

  /** Counts one login request from `ip` against the all-requests cap, before the body is even read. */
  loginRequest(ip: string): RateLimited | null {
    const decision = this.#ipLogins.hit(ip, this.#now());
    return decision.allowed ? null : { limited: true, rule: "loginRequestsPerIp", retryAfterMs: decision.retryAfterMs };
  }

  /**
   * Checks the failure limiters for a login of `email` (already normalized, or null if the body
   * had no string email) from `ip`. Blocked: the longest wait among the rules that tripped.
   * Allowed: a reserved attempt to settle with the outcome.
   */
  loginAttempt(email: string | null, ip: string): RateLimited | LoginAttempt {
    const now = this.#now();
    const pairKey = email === null ? null : `${email}\n${ip}`;
    const checks: Array<[keyof AccountsRateLimits, SlidingWindowLimiter, string | null]> = [
      ["loginFailuresPerEmailAndIp", this.#emailAndIp, pairKey],
      ["loginFailuresPerEmail", this.#email, email],
      ["loginFailuresPerIp", this.#ipFailures, ip],
    ];
    let blocked: RateLimited | null = null;
    for (const [rule, limiter, key] of checks) {
      if (key === null) continue;
      const decision = limiter.check(key, now);
      if (!decision.allowed && (!blocked || decision.retryAfterMs > blocked.retryAfterMs)) {
        blocked = { limited: true, rule, retryAfterMs: decision.retryAfterMs };
      }
    }
    if (blocked) return blocked;

    for (const [, limiter, key] of checks) if (key !== null) limiter.record(key, now);
    let settled = false;
    return {
      limited: false,
      failed: () => {
        settled = true; // the reserved slots simply stay counted
      },
      succeeded: () => {
        if (settled) return;
        settled = true;
        // The right password for this email from this IP: that pair's failure history is moot,
        // so a user who fumbled a few times starts clean. The wider counters (this email from
        // every IP, this IP across every email) are NOT wiped: a success from one place says
        // nothing about guesses coming from elsewhere, and an attacker could otherwise log into
        // their own account between guesses to reset their IP's count. Only this attempt's own
        // reserved slot is handed back to them.
        if (pairKey !== null) this.#emailAndIp.reset(pairKey);
        if (email !== null) this.#email.release(email, now);
        this.#ipFailures.release(ip, now);
      },
    };
  }
}
