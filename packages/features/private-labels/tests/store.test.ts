import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JsonFilePrivateLabelStore } from "../src/store.ts";
import { ETH_ADDR, ETH_ADDR_2, SOL_ADDR, withTempDir } from "./helpers.ts";

const T1 = "2026-10-21T12:00:00.000Z";
const T2 = "2026-10-21T13:00:00.000Z";

test("a missing file reads as no labels", async () => {
  await withTempDir(async (dir) => {
    const store = new JsonFilePrivateLabelStore(join(dir, "private-labels.json"));
    assert.equal(await store.get("u1", "ethereum", ETH_ADDR), null);
    assert.deepEqual(await store.list("u1"), []);
    assert.equal(await store.delete("u1", "ethereum", ETH_ADDR), false);
  });
});

test("labels persist across separate store instances on the same file", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "private-labels.json");
    await new JsonFilePrivateLabelStore(path).set("u1", "ethereum", ETH_ADDR, "my cold wallet", T1);
    const reopened = new JsonFilePrivateLabelStore(path);
    assert.deepEqual(await reopened.get("u1", "ethereum", ETH_ADDR), {
      userId: "u1",
      chain: "ethereum",
      address: ETH_ADDR,
      label: "my cold wallet",
      createdAt: T1,
      updatedAt: T1,
    });
  });
});

test("the file is created owner-only (0600) in an owner-only (0700) directory, with no temp files left", async () => {
  await withTempDir(async (dir) => {
    const sub = join(dir, "private");
    const path = join(sub, "private-labels.json");
    await new JsonFilePrivateLabelStore(path).set("u1", "ethereum", ETH_ADDR, "x", T1);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(sub)).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(sub), ["private-labels.json"]);
  });
});

test("set replaces in place: createdAt kept, updatedAt moves, created flag reports which", async () => {
  await withTempDir(async (dir) => {
    const store = new JsonFilePrivateLabelStore(join(dir, "p.json"));
    const first = await store.set("u1", "ethereum", ETH_ADDR, "first", T1);
    assert.ok(first.ok && first.created);
    const second = await store.set("u1", "ethereum", ETH_ADDR, "second", T2);
    assert.ok(second.ok && !second.created);
    assert.equal(second.label.createdAt, T1);
    assert.equal(second.label.updatedAt, T2);
    assert.equal((await store.list("u1")).length, 1);
  });
});

test("ISOLATION (store level): two users labelling the same address get two independent entries", async () => {
  await withTempDir(async (dir) => {
    const store = new JsonFilePrivateLabelStore(join(dir, "p.json"));
    await store.set("alice", "ethereum", ETH_ADDR, "alice's note", T1);
    await store.set("bob", "ethereum", ETH_ADDR, "bob's secret", T1);
    await store.set("bob", "solana", SOL_ADDR, "bob's other secret", T1);

    assert.equal((await store.get("alice", "ethereum", ETH_ADDR))?.label, "alice's note");
    assert.equal((await store.get("bob", "ethereum", ETH_ADDR))?.label, "bob's secret");
    assert.equal(await store.get("alice", "solana", SOL_ADDR), null);
    assert.deepEqual((await store.list("alice")).map((l) => l.label), ["alice's note"]);
    assert.equal((await store.list("bob")).length, 2);
    // An id nobody has, including one that merely prefixes a real one, sees nothing.
    assert.deepEqual(await store.list("bo"), []);

    // Alice overwriting "her" label on the shared address must not touch Bob's.
    await store.set("alice", "ethereum", ETH_ADDR, "alice edited", T2);
    assert.equal((await store.get("bob", "ethereum", ETH_ADDR))?.label, "bob's secret");

    // Alice deleting the shared address deletes only hers; a second delete finds nothing of hers.
    assert.equal(await store.delete("alice", "ethereum", ETH_ADDR), true);
    assert.equal(await store.delete("alice", "ethereum", ETH_ADDR), false);
    assert.equal((await store.get("bob", "ethereum", ETH_ADDR))?.label, "bob's secret");
    // Deleting an address only Bob has labelled, as Alice, is a no-op.
    assert.equal(await store.delete("alice", "solana", SOL_ADDR), false);
    assert.equal((await store.list("bob")).length, 2);
  });
});

test("an empty owner id is refused rather than treated as a wildcard", async () => {
  await withTempDir(async (dir) => {
    const store = new JsonFilePrivateLabelStore(join(dir, "p.json"));
    await store.set("u1", "ethereum", ETH_ADDR, "x", T1);
    await assert.rejects(store.list(""));
    await assert.rejects(store.get("", "ethereum", ETH_ADDR));
    await assert.rejects(store.set("", "ethereum", ETH_ADDR, "x", T1));
    await assert.rejects(store.delete("", "ethereum", ETH_ADDR));
    assert.equal((await store.list("u1")).length, 1);
  });
});

test("concurrent writes from many users all land (no lost update), and each user still sees only their own", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "p.json");
    const store = new JsonFilePrivateLabelStore(path);
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => store.set(`u${i}`, "ethereum", ETH_ADDR, `label of u${i}`, T1)),
    );
    const reopened = new JsonFilePrivateLabelStore(path);
    for (let i = 0; i < 25; i++) {
      const mine = await reopened.list(`u${i}`);
      assert.deepEqual(mine.map((l) => l.label), [`label of u${i}`]);
    }
  });
});

test("a write through one instance doesn't overwrite another instance's change with a stale copy", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "p.json");
    const a = new JsonFilePrivateLabelStore(path);
    const b = new JsonFilePrivateLabelStore(path);
    await a.set("u1", "ethereum", ETH_ADDR, "from a", T1);
    await b.set("u2", "ethereum", ETH_ADDR_2, "from b", T1);
    await a.set("u1", "solana", SOL_ADDR, "from a again", T2);
    assert.equal((await b.get("u2", "ethereum", ETH_ADDR_2))?.label, "from b");
    assert.equal((await b.list("u1")).length, 2);
  });
});

test("list is most-recently-updated first", async () => {
  await withTempDir(async (dir) => {
    const store = new JsonFilePrivateLabelStore(join(dir, "p.json"));
    await store.set("u1", "ethereum", ETH_ADDR, "older", T1);
    await store.set("u1", "ethereum", ETH_ADDR_2, "newer", T2);
    assert.deepEqual((await store.list("u1")).map((l) => l.label), ["newer", "older"]);
  });
});

test("the per-user limit is enforced per user (another user is unaffected), and updates still work at the limit", async () => {
  await withTempDir(async (dir) => {
    const store = new JsonFilePrivateLabelStore(join(dir, "p.json"), { perUserLimit: 2 });
    assert.ok((await store.set("u1", "ethereum", ETH_ADDR, "a", T1)).ok);
    assert.ok((await store.set("u1", "ethereum", ETH_ADDR_2, "b", T1)).ok);
    assert.deepEqual(await store.set("u1", "solana", SOL_ADDR, "c", T1), { ok: false, reason: "limit_reached" });
    assert.ok((await store.set("u1", "ethereum", ETH_ADDR, "a edited", T2)).ok);
    assert.ok((await store.set("u2", "solana", SOL_ADDR, "other user", T1)).ok);
  });
});

test("a file that isn't a version-1 private-labels file is refused, not silently overwritten", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "p.json");
    await writeFile(path, JSON.stringify({ something: "else" }));
    const store = new JsonFilePrivateLabelStore(path);
    await assert.rejects(store.list("u1"), /not a version-1/);
    await assert.rejects(store.set("u1", "ethereum", ETH_ADDR, "x", T1), /not a version-1/);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { something: "else" });
  });
});
