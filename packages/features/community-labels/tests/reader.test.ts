import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { CompositeLabelStore, isSubmittedLabel, JsonFileLabelStore, type Address } from "@osstrace/core";
import { CommunityLabelReader } from "../src/reader.ts";
import { JsonFileSubmissionStore } from "../src/store.ts";
import { ETH_ADDRESS, validBody, withEnv } from "./helpers.ts";

const ADDRESS: Address = { chain: "ethereum", value: ETH_ADDRESS.toLowerCase() };

test("a fresh submission is publicly visible as a community (unreviewed) label, with its source", async () => {
  await withEnv(async ({ service, account, store }) => {
    const reader = new CommunityLabelReader(store);
    assert.equal(await reader.getLabel(ADDRESS), null);

    const alice = await account("alice@example.com");
    const submitted = await service.submit(alice.token, validBody());
    assert.ok(submitted.ok);

    const label = await reader.getLabel(ADDRESS);
    assert.ok(label && isSubmittedLabel(label));
    assert.equal(label.reviewStatus, "community");
    assert.equal(label.name, "Safe: Safe v1.4.1");
    assert.equal(label.submittedBy, alice.user.id);
    assert.equal(label.submissionId, submitted.submission.id);
    assert.ok(label.source.url.startsWith("https://"));
    assert.deepEqual(await reader.getTags(ADDRESS), []);
  });
});

test("after confirmation the label carries reviewStatus confirmed + who confirmed it", async () => {
  await withEnv(async ({ service, account, store, clock }) => {
    const reader = new CommunityLabelReader(store);
    const alice = await account("alice@example.com");
    const mod = await account("mod@example.com", "moderator");
    const submitted = await service.submit(alice.token, validBody());
    assert.ok(submitted.ok);
    clock.advance(1000);
    assert.ok((await service.confirm(mod.token, submitted.submission.id)).ok);

    const label = await reader.getLabel(ADDRESS);
    assert.ok(label?.reviewStatus === "confirmed");
    assert.equal(label.confirmedBy, mod.user.id);
    assert.equal(label.confirmedAt, clock.now().toISOString());
  });
});

test("a confirmed label outranks a newer unreviewed one", async () => {
  await withEnv(async ({ service, account, store, clock }) => {
    const reader = new CommunityLabelReader(store);
    const alice = await account("alice@example.com");
    const bob = await account("bob@example.com");
    const mod = await account("mod@example.com", "moderator");

    const a = await service.submit(alice.token, validBody({ name: "Safe v1.4.1 (alice)" }));
    assert.ok(a.ok);
    clock.advance(1000);
    assert.ok((await service.confirm(mod.token, a.submission.id)).ok);
    clock.advance(1000);
    assert.ok((await service.submit(bob.token, validBody({ name: "Something newer (bob)" }))).ok);
    assert.equal((await reader.getLabel(ADDRESS))?.name, "Safe v1.4.1 (alice)");
  });
});

test("with nothing confirmed the newest unreviewed one shows; rejected ones are never shown", async () => {
  await withEnv(async ({ service, account, store, clock }) => {
    const reader = new CommunityLabelReader(store);
    const x = await account("x@example.com");
    const y = await account("y@example.com");
    const mod = await account("mod@example.com", "moderator");
    const older = await service.submit(x.token, validBody({ name: "older" }));
    clock.advance(1000);
    const newer = await service.submit(y.token, validBody({ name: "newer" }));
    assert.ok(older.ok && newer.ok);
    assert.equal((await reader.getLabel(ADDRESS))?.name, "newer");

    assert.ok((await service.reject(mod.token, newer.submission.id, "unsupported by the source")).ok);
    assert.equal((await reader.getLabel(ADDRESS))?.name, "older");
    assert.ok((await service.reject(mod.token, older.submission.id, "unsupported by the source")).ok);
    assert.equal(await reader.getLabel(ADDRESS), null);
  });
});

test("plugged into CompositeLabelStore, an ingested label always wins over a community one", async () => {
  await withEnv(async ({ service, account, store, dir }) => {
    const ingested = new JsonFileLabelStore(join(dir, "ingested.json"));
    await ingested.addLabel({
      address: ADDRESS,
      name: "Safe: Safe v1.4.1",
      confidence: "verified",
      source: {
        description: "Safe's official published deployment list (safe-global/safe-deployments, src/assets/v1.4.1/safe.json)",
        url: "https://github.com/safe-global/safe-deployments/blob/main/src/assets/v1.4.1/safe.json",
        addedAt: "2026-10-21",
      },
    });
    const composite = new CompositeLabelStore([ingested], [new CommunityLabelReader(store)]);

    const alice = await account("alice@example.com");
    assert.ok((await service.submit(alice.token, validBody({ name: "A community name" }))).ok);

    const shown = await composite.getLabel(ADDRESS);
    assert.ok(shown && !isSubmittedLabel(shown), "the ingested (official) label takes precedence");
    assert.equal(shown.reviewStatus, undefined);

    // An address only the community has labeled falls through to the community reader.
    const other: Address = { chain: "ethereum", value: "0x29fcb43b46531bca003ddc8fcb67ffe91900c762" };
    const l2 = validBody({
      address: other.value,
      name: "Safe: SafeL2 v1.4.1",
      source: {
        url: "https://github.com/safe-global/safe-deployments/blob/main/src/assets/v1.4.1/safe_l2.json",
        description: "Safe's official deployments registry lists this as the SafeL2 v1.4.1 contract on Ethereum mainnet",
      },
    });
    assert.ok((await service.submit(alice.token, l2)).ok);
    assert.equal((await composite.getLabel(other))?.reviewStatus, "community");
  });
});

test("a second process reading the same file sees new submissions immediately (no stale cache)", async () => {
  await withEnv(async ({ service, account, submissionsPath }) => {
    const otherProcessReader = new CommunityLabelReader(new JsonFileSubmissionStore(submissionsPath));
    assert.equal(await otherProcessReader.getLabel(ADDRESS), null);
    const alice = await account("alice@example.com");
    assert.ok((await service.submit(alice.token, validBody())).ok);
    assert.equal((await otherProcessReader.getLabel(ADDRESS))?.reviewStatus, "community");
  });
});
