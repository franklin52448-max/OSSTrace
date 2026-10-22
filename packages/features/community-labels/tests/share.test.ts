import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { CommunityLabelReader } from "../src/reader.ts";
import { ETH_ADDRESS, validBody, withEnv } from "./helpers.ts";

// "Share as Community label" (ADR 0017): a private label (no source) pre-fills a public
// submission, which still needs a real source. All of it runs against the real private-labels
// service and the real submissions store, over real temp files.

const PRIVATE_TEXT = "Safe v1.4.1 singleton (my note)";
const SOURCE = validBody()["source"];

test("the share draft is pre-filled from your own private label, with no confidence or source, and writes nothing", async () => {
  await withEnv(async ({ service, privateLabels, account, submissionsPath }) => {
    const { token } = await account("alice@example.com");
    assert.ok((await privateLabels.set(token, "ethereum", ETH_ADDRESS, PRIVATE_TEXT)).ok);

    const draft = await service.shareDraft(token, "ethereum", ETH_ADDRESS);
    assert.ok(draft.ok, JSON.stringify(draft));
    assert.deepEqual(draft.draft, {
      chain: "ethereum",
      address: ETH_ADDRESS.toLowerCase(),
      name: PRIVATE_TEXT,
      confidence: null,
      source: null,
    });
    assert.equal(existsSync(submissionsPath), false, "a draft must not create a submission");
  });
});

test("sharing is refused without a real source, by the same validation as any submission, and changes nothing", async () => {
  await withEnv(async ({ service, privateLabels, privateLabelsPath, account, store }) => {
    const { token } = await account("alice@example.com");
    assert.ok((await privateLabels.set(token, "ethereum", ETH_ADDRESS, PRIVATE_TEXT)).ok);
    const privateBefore = await readFile(privateLabelsPath, "utf8");

    const cases: Array<[string, Record<string, unknown>]> = [
      ["no source at all", { chain: "ethereum", address: ETH_ADDRESS, confidence: "verified" }],
      ["blank source url", { chain: "ethereum", address: ETH_ADDRESS, confidence: "verified", source: { url: " ", description: "x" } }],
      ["source with no description", { chain: "ethereum", address: ETH_ADDRESS, confidence: "verified", source: { url: "https://example.org/a" } }],
      ["localhost source", { chain: "ethereum", address: ETH_ADDRESS, confidence: "verified", source: { url: "http://localhost/a", description: "x" } }],
      ["no confidence", { chain: "ethereum", address: ETH_ADDRESS, source: SOURCE }],
    ];
    for (const [what, body] of cases) {
      const result = await service.shareFromPrivateLabel(token, body);
      assert.equal(result.ok, false, `${what} should be refused`);
      assert.equal(!result.ok && result.error, "invalid_submission", what);
    }
    assert.deepEqual(await store.list(), [], "nothing may be submitted without a source");
    assert.equal(await readFile(privateLabelsPath, "utf8"), privateBefore, "the private label file is untouched");
  });
});

test("sharing with a real source creates an independent Community submission; the private label is untouched", async () => {
  await withEnv(async ({ service, privateLabels, privateLabelsPath, account, store }) => {
    const { user, token } = await account("alice@example.com");
    assert.ok((await privateLabels.set(token, "ethereum", ETH_ADDRESS, PRIVATE_TEXT)).ok);
    const privateBefore = await readFile(privateLabelsPath, "utf8");

    const shared = await service.shareFromPrivateLabel(token, {
      chain: "ethereum",
      address: ETH_ADDRESS,
      confidence: "verified",
      source: SOURCE,
    });
    assert.ok(shared.ok, JSON.stringify(shared));
    assert.equal(shared.submission.status, "community");
    assert.equal(shared.submission.name, PRIVATE_TEXT);
    assert.equal(shared.submission.submittedBy, user.id);
    assert.deepEqual((await store.list()).map((s) => s.id), [shared.submission.id]);

    // It's a real public Community label now, exactly like any other submission.
    const label = await new CommunityLabelReader(store).getLabel({ chain: "ethereum", value: ETH_ADDRESS.toLowerCase() });
    assert.equal(label?.reviewStatus, "community");
    assert.equal(label?.name, PRIVATE_TEXT);
    assert.equal(label?.source.url, (SOURCE as { url: string }).url);

    // ...and the private label is byte-for-byte what it was, still private, still there.
    assert.equal(await readFile(privateLabelsPath, "utf8"), privateBefore);
    const mine = await privateLabels.get(token, "ethereum", ETH_ADDRESS);
    assert.ok(mine.ok);
    assert.equal(mine.label?.label, PRIVATE_TEXT);
  });
});

test("the pre-filled name can be edited before sharing, and is validated like any name", async () => {
  await withEnv(async ({ service, privateLabels, account }) => {
    const { token } = await account("alice@example.com");
    // Private labels allow up to 200 characters; a public name is capped at 120.
    assert.ok((await privateLabels.set(token, "ethereum", ETH_ADDRESS, "x".repeat(150))).ok);
    const tooLong = await service.shareFromPrivateLabel(token, { chain: "ethereum", address: ETH_ADDRESS, confidence: "verified", source: SOURCE });
    assert.equal(!tooLong.ok && tooLong.error, "invalid_submission");

    const edited = await service.shareFromPrivateLabel(token, {
      chain: "ethereum",
      address: ETH_ADDRESS,
      name: "Safe: Safe v1.4.1",
      confidence: "verified",
      source: SOURCE,
    });
    assert.ok(edited.ok);
    assert.equal(edited.submission.name, "Safe: Safe v1.4.1");
  });
});

test("the private label survives whatever happens to the shared submission (rejected, then re-shared and confirmed)", async () => {
  await withEnv(async ({ service, privateLabels, privateLabelsPath, account }) => {
    const { token } = await account("alice@example.com");
    const mod = await account("mod@example.com", "moderator");
    assert.ok((await privateLabels.set(token, "ethereum", ETH_ADDRESS, PRIVATE_TEXT)).ok);
    const privateBefore = await readFile(privateLabelsPath, "utf8");
    const body = { chain: "ethereum", address: ETH_ADDRESS, confidence: "verified", source: SOURCE };

    const first = await service.shareFromPrivateLabel(token, body);
    assert.ok(first.ok);
    assert.ok((await service.reject(mod.token, first.submission.id, "the source doesn't mention this address")).ok);
    assert.equal(await readFile(privateLabelsPath, "utf8"), privateBefore, "a rejection doesn't touch the private label");

    const second = await service.shareFromPrivateLabel(token, body);
    assert.ok(second.ok);
    assert.ok((await service.confirm(mod.token, second.submission.id)).ok);
    assert.equal(await readFile(privateLabelsPath, "utf8"), privateBefore, "a confirmation doesn't touch it either");
  });
});

test("you can only share your own private label: none, or someone else's, is not_found", async () => {
  await withEnv(async ({ service, privateLabels, account, store }) => {
    const alice = await account("alice@example.com");
    const bob = await account("bob@example.com");
    assert.ok((await privateLabels.set(alice.token, "ethereum", ETH_ADDRESS, PRIVATE_TEXT)).ok);

    const bobDraft = await service.shareDraft(bob.token, "ethereum", ETH_ADDRESS);
    assert.equal(!bobDraft.ok && bobDraft.error, "not_found");
    assert.ok(!bobDraft.ok && !bobDraft.message.includes(PRIVATE_TEXT), "nothing of alice's label leaks");
    const bobShare = await service.shareFromPrivateLabel(bob.token, { chain: "ethereum", address: ETH_ADDRESS, confidence: "verified", source: SOURCE });
    assert.equal(!bobShare.ok && bobShare.error, "not_found");
    assert.deepEqual(await store.list(), []);

    const bad = await service.shareDraft(alice.token, "ethereum", "0x1234");
    assert.equal(!bad.ok && bad.error, "invalid_submission");
    const anon = await service.shareDraft(null, "ethereum", ETH_ADDRESS);
    assert.equal(!anon.ok && anon.error, "unauthenticated");
  });
});
