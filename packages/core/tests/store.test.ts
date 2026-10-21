import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileLabelStore } from "../src/store.ts";
import type { Address, Label, Tag } from "../src/types.ts";

async function withTempStore(run: (store: JsonFileLabelStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "opentrace-store-test-"));
  const path = join(dir, "labels.json");
  try {
    await run(new JsonFileLabelStore(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const addr: Address = { chain: "ethereum", value: "0xabc" };

test("getLabel returns null before any write, and is per-address", async () => {
  await withTempStore(async (store) => {
    assert.equal(await store.getLabel(addr), null);
    const other: Address = { chain: "ethereum", value: "0xdef" };
    assert.equal(await store.getLabel(other), null);
  });
});

test("addLabel then getLabel round-trips, and a second addLabel replaces the first", async () => {
  await withTempStore(async (store) => {
    const label: Label = {
      address: addr,
      name: "Test Exchange",
      confidence: "verified",
      source: { description: "unit test", url: "https://example.test", addedAt: "2026-10-21" },
    };
    await store.addLabel(label);
    assert.deepEqual(await store.getLabel(addr), label);

    const updated: Label = { ...label, name: "Renamed Exchange" };
    await store.addLabel(updated);
    assert.deepEqual(await store.getLabel(addr), updated);
  });
});

test("addTag accumulates multiple tags for the same address", async () => {
  await withTempStore(async (store) => {
    const tagA: Tag = {
      address: addr,
      tag: "exchange",
      source: { description: "unit test", url: "https://example.test", addedAt: "2026-10-21" },
    };
    const tagB: Tag = { ...tagA, tag: "sanctioned" };
    await store.addTag(tagA);
    await store.addTag(tagB);
    const tags = await store.getTags(addr);
    assert.equal(tags.length, 2);
    assert.deepEqual(
      tags.map((t) => t.tag).sort(),
      ["exchange", "sanctioned"],
    );
  });
});

test("a store persists across separate instances pointed at the same file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opentrace-store-test-"));
  const path = join(dir, "labels.json");
  try {
    const label: Label = {
      address: addr,
      name: "Persisted",
      confidence: "predicted",
      source: { description: "unit test", url: "https://example.test", addedAt: "2026-10-21" },
    };
    await new JsonFileLabelStore(path).addLabel(label);
    const reopened = new JsonFileLabelStore(path);
    assert.deepEqual(await reopened.getLabel(addr), label);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("getEntity finds an entity by any one of its addresses", async () => {
  await withTempStore(async (store) => {
    const second: Address = { chain: "solana", value: "SoLabc" };
    await store.addEntity({
      id: "entity-1",
      name: "Cross-chain Actor",
      addresses: [addr, second],
      source: { description: "unit test", url: "https://example.test", addedAt: "2026-10-21" },
    });
    const byFirst = await store.getEntity(addr);
    const bySecond = await store.getEntity(second);
    assert.equal(byFirst?.id, "entity-1");
    assert.equal(bySecond?.id, "entity-1");
  });
});
