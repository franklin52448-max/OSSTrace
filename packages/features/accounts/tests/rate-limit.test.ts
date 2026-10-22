import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountsRateLimiter, DEFAULT_ACCOUNTS_RATE_LIMITS, SlidingWindowLimiter, ipKey } from "../src/rate-limit.ts";

test("sliding window: limit events, then exactly the oldest event's expiry frees one slot", () => {
  const limiter = new SlidingWindowLimiter({ limit: 3, windowMs: 1000 });
  assert.deepEqual(limiter.hit("k", 0), { allowed: true });
  assert.deepEqual(limiter.hit("k", 100), { allowed: true });
  assert.deepEqual(limiter.hit("k", 200), { allowed: true });
  assert.deepEqual(limiter.hit("k", 500), { allowed: false, retryAfterMs: 500 });
  // A blocked event isn't recorded, so it doesn't push the window out further.
  assert.deepEqual(limiter.check("k", 999), { allowed: false, retryAfterMs: 1 });
  assert.deepEqual(limiter.hit("k", 1000), { allowed: true });
  assert.deepEqual(limiter.hit("k", 1000), { allowed: false, retryAfterMs: 100 });
  // A different key is independent.
  assert.deepEqual(limiter.check("other", 1000), { allowed: true });
});

test("sliding window: release un-counts one event, reset forgets the key, expired keys are swept", () => {
  const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 1000 });
  limiter.record("k", 10);
  limiter.record("k", 20);
  assert.equal(limiter.check("k", 30).allowed, false);
  limiter.release("k", 20);
  assert.equal(limiter.check("k", 30).allowed, true);
  limiter.reset("k");
  assert.equal(limiter.size, 0);

  const swept = new SlidingWindowLimiter({ limit: 2, windowMs: 1000 });
  for (let i = 0; i < SlidingWindowLimiter.SWEEP_EVERY - 1; i++) swept.record(`old-${i}`, 0);
  assert.equal(swept.size, SlidingWindowLimiter.SWEEP_EVERY - 1);
  swept.record("new", 5000); // the sweep runs on this write and drops every aged-out key
  assert.equal(swept.size, 1);
});

test("sliding window: live keys are capped, dropping the least recently written", () => {
  // limit 1, so check() reveals whether a key is still tracked (tracked = blocked).
  const limiter = new SlidingWindowLimiter({ limit: 1, windowMs: 60_000 }, 3);
  for (const key of ["a", "b", "c"]) limiter.record(key, 0);
  limiter.release("a", 0);
  limiter.record("a", 1); // "a" is now the most recently written
  limiter.record("d", 2); // 4 live keys > 3: the least recently written, "b", is dropped
  assert.equal(limiter.size, 3);
  assert.equal(limiter.check("b", 3).allowed, true);
  for (const key of ["a", "c", "d"]) assert.equal(limiter.check(key, 3).allowed, false, key);
});

test("ipKey: IPv4 as-is, IPv4-mapped IPv6 unwrapped, IPv6 grouped by /64", () => {
  assert.equal(ipKey("203.0.113.7"), "203.0.113.7");
  assert.equal(ipKey("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(ipKey("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
  assert.equal(ipKey("2001:0db8:0001:0002:ffff:ffff:ffff:ffff"), "2001:db8:1:2::/64");
  assert.equal(ipKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(ipKey("::1"), "0:0:0:0::/64");
  assert.equal(ipKey("fe80::1%en0"), "fe80:0:0:0::/64");
  assert.equal(ipKey(undefined), "unknown");
});

test("login policy: per-IP failures span emails and survive a success; per-email failures span IPs", () => {
  let now = 0;
  const limiter = new AccountsRateLimiter({}, () => now);
  const fail = (email: string, ip: string) => {
    const attempt = limiter.loginAttempt(email, ip);
    if (attempt.limited) return attempt;
    attempt.failed();
    return null;
  };

  // One IP spraying different emails trips the per-IP failure cap (30), not the per-email one.
  for (let i = 0; i < DEFAULT_ACCOUNTS_RATE_LIMITS.loginFailuresPerIp.limit; i++) assert.equal(fail(`user${i}@x.test`, "198.51.100.1"), null);
  const sprayed = fail("fresh@x.test", "198.51.100.1");
  assert.equal(sprayed?.rule, "loginFailuresPerIp");
  // A success from that IP for some account doesn't wipe the IP's failure count.
  now += 1;
  const blockedEvenForOwnAccount = limiter.loginAttempt("own@x.test", "198.51.100.1");
  assert.equal(blockedEvenForOwnAccount.limited, true);
  // Another IP is unaffected.
  assert.equal(fail("fresh@x.test", "198.51.100.2"), null);

  // Many IPs guessing one email trip the per-email cap (20) even though no single IP hit 5.
  now = 10 * 60_000;
  for (let i = 0; i < DEFAULT_ACCOUNTS_RATE_LIMITS.loginFailuresPerEmail.limit; i++) {
    assert.equal(fail("target@x.test", `192.0.2.${i}`), null);
  }
  const distributed = fail("target@x.test", "192.0.2.200");
  assert.equal(distributed?.rule, "loginFailuresPerEmail");
  assert.equal(distributed?.limited, true);
});

test("login policy: a success releases its own reserved slot from the wider counters", () => {
  const limiter = new AccountsRateLimiter({ loginFailuresPerIp: { limit: 2, windowMs: 60_000 } }, () => 0);
  for (let i = 0; i < 10; i++) {
    const attempt = limiter.loginAttempt(`me${i}@x.test`, "203.0.113.9");
    assert.equal(attempt.limited, false, `success ${i} must not be counted as a failure`);
    if (!attempt.limited) attempt.succeeded();
  }
});

test("signup policy: per IP only, default 10 per hour", () => {
  let now = 0;
  const limiter = new AccountsRateLimiter({}, () => now);
  for (let i = 0; i < 10; i++) assert.equal(limiter.signup("203.0.113.1"), null);
  const blocked = limiter.signup("203.0.113.1");
  assert.equal(blocked?.rule, "signupRequestsPerIp");
  assert.equal(blocked?.retryAfterMs, 60 * 60_000);
  assert.equal(limiter.signup("203.0.113.2"), null);
  now = 60 * 60_000;
  assert.equal(limiter.signup("203.0.113.1"), null);
});
