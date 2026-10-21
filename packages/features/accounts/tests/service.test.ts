import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import argon2 from "argon2";
import { AccountService, DEFAULT_SESSION_TTL_MS, hashSessionToken } from "../src/service.ts";
import { JsonFileAccountStore } from "../src/store.ts";
import { GOOD_PASSWORD, TestClock, withTempAccountsFile } from "./helpers.ts";

/** A real service over a real temp-file store. The only test hook is the clock. */
async function withService(
  run: (service: AccountService, ctx: { path: string; clock: TestClock; store: JsonFileAccountStore }) => Promise<void>,
): Promise<void> {
  await withTempAccountsFile(async (path) => {
    const clock = new TestClock();
    const store = new JsonFileAccountStore(path, { now: clock.now });
    await run(new AccountService(store, { now: clock.now }), { path, clock, store });
  });
}

function unwrap<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  assert.ok(result.ok, `expected ok, got ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}

test("signup creates a plain 'user', returns a working session, and never exposes the hash", async () => {
  await withService(async (service) => {
    const signed = unwrap(await service.signup("New@Example.com", GOOD_PASSWORD));
    assert.equal(signed.user.email, "new@example.com");
    assert.equal(signed.user.role, "user");
    assert.ok(!("passwordHash" in signed.user));
    assert.match(signed.session.token, /^ots_[A-Za-z0-9_-]{43}$/);

    const me = unwrap(await service.authenticate(signed.session.token));
    assert.equal(me.user.id, signed.user.id);
  });
});

test("the accounts file stores an argon2id hash and a token hash — never the password or raw token", async () => {
  await withService(async (service, { path }) => {
    const signed = unwrap(await service.signup("a@example.com", GOOD_PASSWORD));
    const raw = await readFile(path, "utf8");
    assert.ok(!raw.includes(GOOD_PASSWORD));
    assert.ok(!raw.includes(signed.session.token));
    assert.ok(raw.includes(hashSessionToken(signed.session.token)));
    const file = JSON.parse(raw) as { users: { passwordHash: string }[] };
    assert.equal(await argon2.verify(file.users[0]!.passwordHash, GOOD_PASSWORD), true);
  });
});

test("signup rejects bad input and duplicate emails (case-insensitively)", async () => {
  await withService(async (service) => {
    assert.equal((await service.signup("not-an-email", GOOD_PASSWORD) as { error?: string }).error, "invalid_email");
    assert.equal((await service.signup("a@example.com", "short") as { error?: string }).error, "invalid_password");
    unwrap(await service.signup("a@example.com", GOOD_PASSWORD));
    assert.equal((await service.signup("A@EXAMPLE.com", "another good password") as { error?: string }).error, "email_taken");
  });
});

test("login with the right password works; wrong password and unknown email are both rejected identically", async () => {
  await withService(async (service) => {
    const signed = unwrap(await service.signup("a@example.com", GOOD_PASSWORD));

    const loggedIn = unwrap(await service.login("  A@example.com ", GOOD_PASSWORD));
    assert.equal(loggedIn.user.id, signed.user.id);
    assert.notEqual(loggedIn.session.token, signed.session.token, "each login is its own session");

    const wrong = await service.login("a@example.com", GOOD_PASSWORD + "!");
    const unknown = await service.login("nobody@example.com", GOOD_PASSWORD);
    assert.deepEqual(wrong, unknown);
    assert.deepEqual(wrong, { ok: false, error: "invalid_credentials", message: "wrong email or password" });

    assert.equal((await service.login(undefined, undefined)).ok, false);
    assert.equal((await service.login("a@example.com", "x".repeat(10_000))).ok, false);
  });
});

test("authenticate rejects missing, malformed, forged and logged-out tokens", async () => {
  await withService(async (service) => {
    const signed = unwrap(await service.signup("a@example.com", GOOD_PASSWORD));
    for (const bad of [undefined, null, "", "garbage", "ots_" + "A".repeat(43), signed.session.token + "x"]) {
      const result = await service.authenticate(bad);
      assert.equal(result.ok, false, `token ${String(bad)} should be rejected`);
    }
    unwrap(await service.authenticate(signed.session.token));
    await service.logout(signed.session.token);
    assert.equal((await service.authenticate(signed.session.token)).ok, false);
  });
});

test("logout revokes only that session, not the user's other sessions", async () => {
  await withService(async (service) => {
    const first = unwrap(await service.signup("a@example.com", GOOD_PASSWORD));
    const second = unwrap(await service.login("a@example.com", GOOD_PASSWORD));
    await service.logout(first.session.token);
    assert.equal((await service.authenticate(first.session.token)).ok, false);
    assert.ok((await service.authenticate(second.session.token)).ok);
  });
});

test("a session expires after its TTL — valid one millisecond before, rejected at the deadline", async () => {
  await withService(async (service, { clock }) => {
    const signed = unwrap(await service.signup("a@example.com", GOOD_PASSWORD));
    assert.equal(Date.parse(signed.session.expiresAt) - clock.now().getTime(), DEFAULT_SESSION_TTL_MS);
    clock.advance(DEFAULT_SESSION_TTL_MS - 1);
    assert.ok((await service.authenticate(signed.session.token)).ok);
    clock.advance(1);
    assert.equal((await service.authenticate(signed.session.token)).ok, false);
  });
});

test("requireRole enforces the role hierarchy: user < moderator < admin", async () => {
  await withService(async (service) => {
    const plain = unwrap(await service.signup("user@example.com", GOOD_PASSWORD));
    const mod = unwrap(await service.signup("mod@example.com", GOOD_PASSWORD));
    const admin = unwrap(await service.signup("admin@example.com", GOOD_PASSWORD));
    unwrap(await service.setRoleAsOperator("mod@example.com", "moderator"));
    unwrap(await service.setRoleAsOperator("admin@example.com", "admin"));

    const check = async (token: string, role: "user" | "moderator" | "admin") => {
      const r = await service.requireRole(token, role);
      return r.ok ? "ok" : r.error;
    };
    assert.equal(await check(plain.session.token, "user"), "ok");
    assert.equal(await check(plain.session.token, "moderator"), "forbidden");
    assert.equal(await check(plain.session.token, "admin"), "forbidden");
    assert.equal(await check(mod.session.token, "moderator"), "ok");
    assert.equal(await check(mod.session.token, "admin"), "forbidden");
    assert.equal(await check(admin.session.token, "moderator"), "ok");
    assert.equal(await check(admin.session.token, "admin"), "ok");
    assert.equal((await service.requireRole("ots_bogus", "user") as { error?: string }).error, "unauthenticated");
  });
});

test("only an admin can grant roles; a user or moderator trying to is forbidden and nothing changes", async () => {
  await withService(async (service) => {
    const target = unwrap(await service.signup("target@example.com", GOOD_PASSWORD));
    const mod = unwrap(await service.signup("mod@example.com", GOOD_PASSWORD));
    unwrap(await service.setRoleAsOperator("mod@example.com", "moderator"));

    assert.equal((await service.setRole(target.session.token, target.user.id, "admin") as { error?: string }).error, "forbidden");
    assert.equal((await service.setRole(mod.session.token, target.user.id, "moderator") as { error?: string }).error, "forbidden");
    assert.equal((await service.setRole(undefined, target.user.id, "moderator") as { error?: string }).error, "unauthenticated");
    assert.equal(unwrap(await service.authenticate(target.session.token)).user.role, "user");

    const admin = unwrap(await service.signup("admin@example.com", GOOD_PASSWORD));
    unwrap(await service.setRoleAsOperator("admin@example.com", "admin"));
    const granted = unwrap(await service.setRole(admin.session.token, target.user.id, "moderator"));
    assert.equal(granted.user.role, "moderator");
    assert.equal((await service.setRole(admin.session.token, target.user.id, "superuser") as { error?: string }).error, "invalid_role");
    assert.equal((await service.setRole(admin.session.token, "no-such-id", "moderator") as { error?: string }).error, "not_found");
  });
});

test("role changes take effect on the very next request with the existing session (not baked into the token)", async () => {
  await withService(async (service) => {
    const s = unwrap(await service.signup("a@example.com", GOOD_PASSWORD));
    assert.equal((await service.requireRole(s.session.token, "moderator")).ok, false);
    unwrap(await service.setRoleAsOperator("a@example.com", "moderator"));
    assert.ok((await service.requireRole(s.session.token, "moderator")).ok);
    unwrap(await service.setRoleAsOperator("a@example.com", "user"));
    assert.equal((await service.requireRole(s.session.token, "moderator")).ok, false);
  });
});

test("the last admin can't demote themselves; listing users is admin-only and never includes hashes", async () => {
  await withService(async (service) => {
    const admin = unwrap(await service.signup("admin@example.com", GOOD_PASSWORD));
    const plain = unwrap(await service.signup("user@example.com", GOOD_PASSWORD));
    unwrap(await service.setRoleAsOperator("admin@example.com", "admin"));

    assert.equal((await service.setRole(admin.session.token, admin.user.id, "user") as { error?: string }).error, "last_admin");
    assert.equal((await service.setRoleAsOperator("admin@example.com", "user") as { error?: string }).error, "last_admin");

    assert.equal((await service.listUsers(plain.session.token) as { error?: string }).error, "forbidden");
    const listed = unwrap(await service.listUsers(admin.session.token));
    assert.deepEqual(listed.users.map((u) => u.email).sort(), ["admin@example.com", "user@example.com"]);
    assert.ok(listed.users.every((u) => !("passwordHash" in u)));
  });
});

test("setRoleAsOperator reports an unknown email instead of creating anything", async () => {
  await withService(async (service, { store }) => {
    assert.equal((await service.setRoleAsOperator("ghost@example.com", "admin") as { error?: string }).error, "not_found");
    assert.deepEqual(await store.listUsers(), []);
  });
});

test("login transparently upgrades a hash made with weaker parameters", async () => {
  await withService(async (service, { store }) => {
    const signed = unwrap(await service.signup("a@example.com", GOOD_PASSWORD));
    const weak = await argon2.hash(GOOD_PASSWORD, { type: argon2.argon2id, memoryCost: 4096, timeCost: 1, parallelism: 1 });
    await store.updatePasswordHash(signed.user.id, weak);

    unwrap(await service.login("a@example.com", GOOD_PASSWORD));
    const upgraded = (await store.getUserById(signed.user.id))!.passwordHash;
    assert.notEqual(upgraded, weak);
    assert.match(upgraded, /^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    unwrap(await service.login("a@example.com", GOOD_PASSWORD));
  });
});
