import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { JsonFileAccountStore } from "../src/store.ts";
import type { StoredUser } from "../src/types.ts";
import { TestClock, withTempAccountsFile } from "./helpers.ts";

function user(id: string, email: string, role: StoredUser["role"] = "user"): StoredUser {
  return {
    id,
    email,
    // The store never inspects hashes; real hashing is exercised in password/service tests.
    passwordHash: "$argon2id$v=19$m=19456,p=1,t=2$store-test-fixture",
    role,
    createdAt: "2026-10-21T00:00:00.000Z",
    roleUpdatedAt: "2026-10-21T00:00:00.000Z",
  };
}

test("an empty/missing file reads as no users and no sessions", async () => {
  await withTempAccountsFile(async (path) => {
    const store = new JsonFileAccountStore(path);
    assert.deepEqual(await store.listUsers(), []);
    assert.equal(await store.getUserByEmail("a@example.com"), null);
    assert.equal(await store.getSession("nope"), null);
  });
});

test("users persist across separate store instances on the same file", async () => {
  await withTempAccountsFile(async (path) => {
    assert.equal(await new JsonFileAccountStore(path).createUser(user("u1", "a@example.com")), true);
    const reopened = new JsonFileAccountStore(path);
    assert.equal((await reopened.getUserById("u1"))?.email, "a@example.com");
    assert.equal((await reopened.getUserByEmail("a@example.com"))?.id, "u1");
  });
});

test("the accounts file is written owner-only (0600)", async () => {
  await withTempAccountsFile(async (path) => {
    await new JsonFileAccountStore(path).createUser(user("u1", "a@example.com"));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});

test("createUser refuses a duplicate email, even when both writes race", async () => {
  await withTempAccountsFile(async (path) => {
    const store = new JsonFileAccountStore(path);
    const results = await Promise.all([
      store.createUser(user("u1", "same@example.com")),
      store.createUser(user("u2", "same@example.com")),
    ]);
    assert.deepEqual(results.sort(), [false, true]);
    assert.equal((await store.listUsers()).length, 1);
  });
});

test("concurrent writes for different users all land (no lost update)", async () => {
  await withTempAccountsFile(async (path) => {
    const store = new JsonFileAccountStore(path);
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.createUser(user(`u${i}`, `u${i}@example.com`))));
    assert.equal((await new JsonFileAccountStore(path).listUsers()).length, 20);
  });
});

test("a change written by another process/instance is seen immediately, not overwritten by a stale copy", async () => {
  await withTempAccountsFile(async (path) => {
    const server = new JsonFileAccountStore(path);
    const cli = new JsonFileAccountStore(path);
    await server.createUser(user("u1", "a@example.com"));
    await cli.setRole("u1", "moderator", "2026-10-21T01:00:00.000Z");
    assert.equal((await server.getUserById("u1"))?.role, "moderator");
    // A later write through the first instance must keep the second instance's change.
    await server.createUser(user("u2", "b@example.com"));
    assert.equal((await cli.getUserById("u1"))?.role, "moderator");
  });
});

test("setRole updates role + roleUpdatedAt, reports not_found, and refuses to demote the last admin", async () => {
  await withTempAccountsFile(async (path) => {
    const store = new JsonFileAccountStore(path);
    await store.createUser(user("admin1", "admin@example.com", "admin"));
    await store.createUser(user("u1", "a@example.com"));

    const promoted = await store.setRole("u1", "moderator", "2026-10-21T02:00:00.000Z");
    assert.ok(promoted.ok);
    assert.equal(promoted.user.role, "moderator");
    assert.equal(promoted.user.roleUpdatedAt, "2026-10-21T02:00:00.000Z");

    assert.deepEqual(await store.setRole("ghost", "moderator", "x"), { ok: false, reason: "not_found" });
    assert.deepEqual(await store.setRole("admin1", "user", "x"), { ok: false, reason: "last_admin" });
    assert.equal((await store.getUserById("admin1"))?.role, "admin");

    // With a second admin, the first can be demoted.
    assert.ok((await store.setRole("u1", "admin", "x")).ok);
    assert.ok((await store.setRole("admin1", "user", "x")).ok);
  });
});

test("expired sessions are pruned from the file on the next write", async () => {
  await withTempAccountsFile(async (path) => {
    const clock = new TestClock("2026-10-21T00:00:00.000Z");
    const store = new JsonFileAccountStore(path, { now: clock.now });
    await store.createSession({ tokenHash: "old", userId: "u1", createdAt: "x", expiresAt: "2026-10-21T01:00:00.000Z" });
    await store.createSession({ tokenHash: "new", userId: "u1", createdAt: "x", expiresAt: "2026-10-23T00:00:00.000Z" });
    clock.advance(2 * 60 * 60 * 1000);
    await store.deleteSession("unrelated");
    const onDisk = JSON.parse(await readFile(path, "utf8")) as { sessions: { tokenHash: string }[] };
    assert.deepEqual(onDisk.sessions.map((s) => s.tokenHash), ["new"]);
  });
});

test("a corrupt accounts file is an error, not silently treated as empty", async () => {
  await withTempAccountsFile(async (path) => {
    await writeFile(path, "{ not json", "utf8");
    await assert.rejects(new JsonFileAccountStore(path).listUsers());
    await writeFile(path, JSON.stringify({ users: [] }), "utf8");
    await assert.rejects(new JsonFileAccountStore(path).listUsers(), /not a version-1 accounts file/);
  });
});
