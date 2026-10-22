import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileCaseStore } from "../src/store.ts";
import type { Case } from "../src/types.ts";
import { ETH_ADDR, ETH_ADDR_2, SOL_ADDR } from "./helpers.ts";

async function withFile(run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "osstrace-cases-store-test-"));
  try {
    await run(join(dir, "nested", "cases.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function newCase(ownerId: string, id: string, at = "2026-10-22T12:00:00.000Z"): Case {
  return { id, title: `case ${id}`, description: "", ownedBy: ownerId, status: "open", createdAt: at, updatedAt: at, closedAt: null };
}

test("store: every method refuses an empty owner id instead of treating it as a wildcard", async () =>
  withFile(async (path) => {
    const store = new JsonFileCaseStore(path);
    await store.createCase("alice", newCase("alice", "c1"));
    await assert.rejects(store.listCases(""), /owner id/);
    await assert.rejects(store.getCase("", "c1"), /owner id/);
    await assert.rejects(store.listItems("", "c1"), /owner id/);
    await assert.rejects(store.countItems(""), /owner id/);
    assert.throws(() => store.deleteCase("", "c1"), /owner id/);
    assert.throws(() => store.addItem("", "c1", { id: "i", chain: "ethereum", address: ETH_ADDR, note: "" }, "t"), /owner id/);
    // ...and refuses to create a case owned by someone other than the caller.
    assert.throws(() => store.createCase("alice", newCase("bob", "c2")), /owned by the caller/);
  }));

test("store: one owner's calls never see or touch another owner's case, even with the right case id", async () =>
  withFile(async (path) => {
    const store = new JsonFileCaseStore(path);
    await store.createCase("bob", newCase("bob", "bob-case"));
    await store.addItem("bob", "bob-case", { id: "bob-item", chain: "ethereum", address: ETH_ADDR, note: "bob's secret" }, "t1");

    assert.equal(await store.getCase("alice", "bob-case"), null);
    assert.deepEqual(await store.listItems("alice", "bob-case"), []);
    assert.deepEqual(await store.listCases("alice"), []);
    assert.equal((await store.countItems("alice")).size, 0);
    assert.deepEqual(await store.updateCase("alice", "bob-case", { kind: "details", title: "pwned" }, "t2"), { ok: false, reason: "not_found" });
    assert.deepEqual(await store.updateCase("alice", "bob-case", { kind: "status", status: "closed" }, "t2"), { ok: false, reason: "not_found" });
    assert.deepEqual(await store.addItem("alice", "bob-case", { id: "x", chain: "ethereum", address: ETH_ADDR_2, note: "" }, "t2"), { ok: false, reason: "not_found" });
    assert.deepEqual(await store.updateItemNote("alice", "bob-case", "bob-item", "pwned", "t2"), { ok: false, reason: "not_found" });
    assert.deepEqual(await store.removeItem("alice", "bob-case", "bob-item", "t2"), { ok: false, reason: "not_found" });
    assert.equal(await store.deleteCase("alice", "bob-case"), false);

    // Bob's data is byte-for-byte as he left it.
    const bobCase = await store.getCase("bob", "bob-case");
    assert.equal(bobCase?.title, "case bob-case");
    assert.equal(bobCase?.status, "open");
    const bobItems = await store.listItems("bob", "bob-case");
    assert.deepEqual(bobItems.map((i) => i.note), ["bob's secret"]);
  }));

test("store: an item from one of your cases can't be edited or removed through another of your cases", async () =>
  withFile(async (path) => {
    const store = new JsonFileCaseStore(path);
    await store.createCase("alice", newCase("alice", "a"));
    await store.createCase("alice", newCase("alice", "b"));
    await store.addItem("alice", "a", { id: "item-a", chain: "solana", address: SOL_ADDR, note: "in a" }, "t1");
    assert.deepEqual(await store.updateItemNote("alice", "b", "item-a", "moved?", "t2"), { ok: false, reason: "item_not_found" });
    assert.deepEqual(await store.removeItem("alice", "b", "item-a", "t2"), { ok: false, reason: "item_not_found" });
    assert.deepEqual((await store.listItems("alice", "a")).map((i) => i.note), ["in a"]);
  }));

test("store: deleting a case removes all its items in the same write, and nobody else's", async () =>
  withFile(async (path) => {
    const store = new JsonFileCaseStore(path);
    await store.createCase("alice", newCase("alice", "a"));
    await store.createCase("alice", newCase("alice", "keep"));
    await store.createCase("bob", newCase("bob", "b"));
    await store.addItem("alice", "a", { id: "1", chain: "ethereum", address: ETH_ADDR, note: "" }, "t");
    await store.addItem("alice", "a", { id: "2", chain: "ethereum", address: ETH_ADDR_2, note: "" }, "t");
    await store.addItem("alice", "keep", { id: "3", chain: "ethereum", address: ETH_ADDR, note: "" }, "t");
    await store.addItem("bob", "b", { id: "4", chain: "ethereum", address: ETH_ADDR, note: "" }, "t");

    assert.equal(await store.deleteCase("alice", "a"), true);
    const file = JSON.parse(await readFile(path, "utf8")) as { cases: Case[]; items: { id: string }[] };
    assert.deepEqual(file.cases.map((c) => c.id).sort(), ["b", "keep"]);
    assert.deepEqual(file.items.map((i) => i.id).sort(), ["3", "4"]);
  }));

test("store: the file is created 0600 in a 0700 directory, and re-read on every call by every instance", async () =>
  withFile(async (path) => {
    const writer = new JsonFileCaseStore(path);
    const reader = new JsonFileCaseStore(path);
    await writer.createCase("alice", newCase("alice", "c1"));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(path, ".."))).mode & 0o777, 0o700);
    // A second store instance on the same file sees the write immediately — no stale cache.
    assert.equal((await reader.getCase("alice", "c1"))?.id, "c1");
    await reader.updateCase("alice", "c1", { kind: "status", status: "closed" }, "t2");
    assert.equal((await writer.getCase("alice", "c1"))?.status, "closed");
  }));

test("store: concurrent writes are serialized — none lost, and the per-owner case limit can't be overshot", async () =>
  withFile(async (path) => {
    const store = new JsonFileCaseStore(path, { casesPerUserLimit: 5 });
    const outcomes = await Promise.all(Array.from({ length: 12 }, (_, i) => store.createCase("alice", newCase("alice", `c${i}`))));
    assert.equal(outcomes.filter((o) => o.ok).length, 5);
    assert.equal(outcomes.filter((o) => !o.ok).length, 7);
    assert.equal((await store.listCases("alice")).length, 5);
    // A different owner has their own allowance.
    assert.equal((await store.createCase("bob", newCase("bob", "b1"))).ok, true);

    const itemStore = new JsonFileCaseStore(path);
    const caseId = (await itemStore.listCases("alice"))[0]!.id;
    const addresses = Array.from({ length: 20 }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`);
    await Promise.all(addresses.map((address, i) => itemStore.addItem("alice", caseId, { id: `i${i}`, chain: "ethereum", address, note: `n${i}` }, "t")));
    assert.equal((await itemStore.listItems("alice", caseId)).length, 20);
    assert.equal((await itemStore.countItems("alice")).get(caseId), 20);
  }));

test("store: refuses to load a file that isn't a version-1 cases file", async () =>
  withFile(async (path) => {
    const store = new JsonFileCaseStore(path);
    await store.createCase("alice", newCase("alice", "c1"));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify({ version: 2, cases: [] }));
    await assert.rejects(store.listCases("alice"), /not a version-1 cases file/);
  }));
