import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompositeLabelStore, JsonFileLabelStore } from "../src/store.ts";
import type { Address, Label, Tag } from "../src/types.ts";

const addr: Address = { chain: "ethereum", value: "0xabc" };
const sourceA = { description: "Source A", url: "https://example.org/a", addedAt: "2026-10-21" };
const sourceB = { description: "Source B", url: "https://example.org/b", addedAt: "2026-10-21" };

async function withTwoStores(run: (a: JsonFileLabelStore, b: JsonFileLabelStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "opentrace-composite-test-"));
  try {
    const labelA: Label = { address: addr, name: "From A", confidence: "verified", source: sourceA };
    const labelB: Label = { address: addr, name: "From B", confidence: "verified", source: sourceB };
    const tagA: Tag = { address: addr, tag: "sanctioned", source: sourceA };
    const tagB: Tag = { address: addr, tag: "sanctioned", source: sourceB };
    await writeFile(join(dir, "a.json"), JSON.stringify({ labels: [labelA], tags: [tagA], entities: [] }));
    await writeFile(join(dir, "b.json"), JSON.stringify({ labels: [labelB], tags: [tagB], entities: [] }));
    await run(new JsonFileLabelStore(join(dir, "a.json")), new JsonFileLabelStore(join(dir, "b.json")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("CompositeLabelStore returns the first store's label, but every store's tags", async () => {
  await withTwoStores(async (a, b) => {
    const store = new CompositeLabelStore([a, b]);
    assert.equal((await store.getLabel(addr))?.name, "From A");
    assert.deepEqual((await store.getTags(addr)).map((t) => t.source.description), ["Source A", "Source B"]);
  });
});

test("CompositeLabelStore falls through to a later store when earlier ones have no label", async () => {
  await withTwoStores(async (a, b) => {
    const other: Address = { chain: "ethereum", value: "0xdef" };
    assert.equal(await new CompositeLabelStore([a, b]).getLabel(other), null);
    assert.equal((await new CompositeLabelStore([b, a]).getLabel(addr))?.name, "From B");
  });
});

test("CompositeLabelStore rejects an empty store list", () => {
  assert.throws(() => new CompositeLabelStore([]));
});
