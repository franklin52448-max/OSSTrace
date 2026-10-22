import { test } from "node:test";
import assert from "node:assert/strict";
import { LabelSubmissionService, SUBMISSION_RATE_LIMIT } from "../src/service.ts";
import { JsonFileSubmissionStore } from "../src/store.ts";
import { validBody, withEnv } from "./helpers.ts";

// Per-account submission rate limit (ADR 0017): SUBMISSION_RATE_LIMIT.max per rolling
// SUBMISSION_RATE_LIMIT.windowMs, counted from the real submissions store.

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/** The n-th of a run of distinct, well-formed Ethereum addresses (one pending submission per address is allowed). */
function addr(n: number): string {
  return `0x${(n + 1).toString(16).padStart(40, "0")}`;
}

test("the documented limit is 10 submissions per rolling hour", () => {
  assert.deepEqual(SUBMISSION_RATE_LIMIT, { max: 10, windowMs: HOUR });
});

test("the 11th submission within the hour is refused as rate_limited, and is allowed again once the window passes", async () => {
  await withEnv(async ({ service, account, store, clock }) => {
    const { token } = await account("alice@example.com");
    for (let i = 0; i < 10; i++) {
      const ok = await service.submit(token, validBody({ address: addr(i) }));
      assert.ok(ok.ok, `submission ${i + 1} should be accepted: ${JSON.stringify(ok)}`);
    }

    const refused = await service.submit(token, validBody({ address: addr(10) }));
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.error, "rate_limited");
    assert.equal(!refused.ok && refused.retryAfterSeconds, 3600, "all ten were made just now, so the first slot frees in an hour");
    assert.match(!refused.ok ? refused.message : "", /try again in 60 minutes/);
    assert.equal((await store.list()).length, 10, "a refused submission is not stored — not a silent drop either");

    clock.advance(HOUR - 1000);
    const stillRefused = await service.submit(token, validBody({ address: addr(10) }));
    assert.equal(!stillRefused.ok && stillRefused.error, "rate_limited");
    assert.equal(!stillRefused.ok && stillRefused.retryAfterSeconds, 1);

    clock.advance(1000);
    const afterWindow = await service.submit(token, validBody({ address: addr(10) }));
    assert.ok(afterWindow.ok, "an hour after the first ten, the window has reset");
  });
});

test("the window rolls: slots free up as each earlier submission ages out, not all at once", async () => {
  await withEnv(async ({ service, account, clock }) => {
    const { token } = await account("alice@example.com");
    for (let i = 0; i < 5; i++) assert.ok((await service.submit(token, validBody({ address: addr(i) }))).ok);
    clock.advance(30 * MINUTE);
    for (let i = 5; i < 10; i++) assert.ok((await service.submit(token, validBody({ address: addr(i) }))).ok);

    const refused = await service.submit(token, validBody({ address: addr(10) }));
    assert.equal(!refused.ok && refused.retryAfterSeconds, 30 * 60);

    clock.advance(30 * MINUTE); // the first five age out; the second five still count
    for (let i = 10; i < 15; i++) assert.ok((await service.submit(token, validBody({ address: addr(i) }))).ok, `slot ${i}`);
    const full = await service.submit(token, validBody({ address: addr(15) }));
    assert.equal(!full.ok && full.error, "rate_limited");
  });
});

test("the limit is per account: another user can still submit", async () => {
  await withEnv(async ({ service, account }) => {
    const alice = await account("alice@example.com");
    const bob = await account("bob@example.com");
    for (let i = 0; i < 10; i++) assert.ok((await service.submit(alice.token, validBody({ address: addr(i) }))).ok);
    assert.equal((await service.submit(alice.token, validBody({ address: addr(10) }))).ok, false);
    assert.ok((await service.submit(bob.token, validBody({ address: addr(10) }))).ok);
  });
});

test("refused (invalid, duplicate) attempts don't use up the limit; rejected submissions and shares do count", async () => {
  await withEnv(async ({ service, privateLabels, account }) => {
    const { token } = await account("alice@example.com");
    const mod = await account("mod@example.com", "moderator");

    for (let i = 0; i < 20; i++) assert.equal((await service.submit(token, validBody({ source: undefined }))).ok, false);
    const first = await service.submit(token, validBody({ address: addr(0) }));
    assert.ok(first.ok);
    for (let i = 0; i < 20; i++) {
      const dup = await service.submit(token, validBody({ address: addr(0) }));
      assert.equal(!dup.ok && dup.error, "duplicate_submission");
    }
    // A rejection doesn't hand the slot back: the moderator's time was spent either way.
    assert.ok((await service.reject(mod.token, first.submission.id, "source doesn't mention it")).ok);

    // Sharing a private label is a submission like any other.
    assert.ok((await privateLabels.set(token, "ethereum", addr(1), "my note")).ok);
    assert.ok((await service.shareFromPrivateLabel(token, validBody({ address: addr(1), name: undefined }))).ok);

    for (let i = 2; i < 10; i++) assert.ok((await service.submit(token, validBody({ address: addr(i) }))).ok, `slot ${i}`);
    assert.ok((await privateLabels.set(token, "ethereum", addr(10), "another note")).ok);
    const sharedOver = await service.shareFromPrivateLabel(token, validBody({ address: addr(10), name: undefined }));
    assert.equal(!sharedOver.ok && sharedOver.error, "rate_limited");
  });
});

test("the limit survives a restart: it's counted from the stored submissions, not held in memory", async () => {
  await withEnv(async ({ service, account, accounts, submissionsPath, clock }) => {
    const { token } = await account("alice@example.com");
    for (let i = 0; i < 10; i++) assert.ok((await service.submit(token, validBody({ address: addr(i) }))).ok);
    const restarted = new LabelSubmissionService(new JsonFileSubmissionStore(submissionsPath), accounts, { now: clock.now });
    const refused = await restarted.submit(token, validBody({ address: addr(10) }));
    assert.equal(!refused.ok && refused.error, "rate_limited");
  });
});

test("concurrent submissions can't race past the limit: exactly 10 of 15 parallel ones land", async () => {
  await withEnv(async ({ service, account, store }) => {
    const { token } = await account("alice@example.com");
    const results = await Promise.all(Array.from({ length: 15 }, (_, i) => service.submit(token, validBody({ address: addr(i) }))));
    assert.equal(results.filter((r) => r.ok).length, 10);
    assert.equal(results.filter((r) => !r.ok && r.error === "rate_limited").length, 5);
    assert.equal((await store.list()).length, 10);
  });
});
