import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ETH_ADDRESS, SOL_ADDRESS, validBody, withEnv } from "./helpers.ts";

test("submitting requires a real, live session", async () => {
  await withEnv(async ({ service, accounts, account }) => {
    assert.equal((await service.submit(null, validBody())).ok, false);
    const forged = await service.submit("ots_not-a-real-token", validBody());
    assert.equal(forged.ok, false);
    assert.equal(!forged.ok && forged.error, "unauthenticated");

    const { token } = await account("alice@example.com");
    await accounts.logout(token);
    const loggedOut = await service.submit(token, validBody());
    assert.equal(!loggedOut.ok && loggedOut.error, "unauthenticated");
  });
});

test("a submission is stored as a community-tier record owned by the submitter's id, not email", async () => {
  await withEnv(async ({ service, account, submissionsPath, clock }) => {
    const { user, token } = await account("alice@example.com");
    const result = await service.submit(token, validBody());
    assert.ok(result.ok);
    const s = result.submission;
    assert.equal(s.status, "community");
    assert.equal(s.submittedBy, user.id);
    assert.equal(s.submittedAt, clock.now().toISOString());
    // Ethereum addresses are canonicalized to lowercase, matching how lookups query the store.
    assert.deepEqual(s.address, { chain: "ethereum", value: ETH_ADDRESS.toLowerCase() });
    assert.equal(s.source.addedAt, "2026-10-21");

    const onDisk = await readFile(submissionsPath, "utf8");
    assert.ok(onDisk.includes(user.id));
    assert.ok(!onDisk.includes("alice@example.com"), "the submissions file must never contain an email");
  });
});

test("every submission needs a real cited source — missing, blank or non-http sources are refused", async () => {
  await withEnv(async ({ service, account, store }) => {
    const { token } = await account("alice@example.com");
    const cases: Array<[string, Record<string, unknown>]> = [
      ["no source", validBody({ source: undefined })],
      ["source not an object", validBody({ source: "trust me" })],
      ["blank url", validBody({ source: { url: "  ", description: "a writeup" } })],
      ["no description", validBody({ source: { url: "https://example.org/report" } })],
      ["blank description", validBody({ source: { url: "https://example.org/report", description: "   " } })],
      ["relative url", validBody({ source: { url: "/report", description: "a writeup" } })],
      ["javascript: url", validBody({ source: { url: "javascript:alert(1)", description: "a writeup" } })],
      ["ftp url", validBody({ source: { url: "ftp://example.org/x", description: "a writeup" } })],
      ["hostless url", validBody({ source: { url: "https://intranet/report", description: "a writeup" } })],
      ["credentials in url", validBody({ source: { url: "https://u:p@example.org/x", description: "a writeup" } })],
      ["bad chain", validBody({ chain: "bitcoin" })],
      ["bad eth address", validBody({ address: "0x1234" })],
      ["not a solana address", validBody({ chain: "solana", address: "0OIl" + "1".repeat(40) })],
      ["blank name", validBody({ name: "  " })],
      ["name too long", validBody({ name: "x".repeat(121) })],
      ["bad confidence", validBody({ confidence: "confirmed" })],
    ];
    for (const [what, body] of cases) {
      const result = await service.submit(token, body);
      assert.equal(result.ok, false, `${what} should be refused`);
      assert.equal(!result.ok && result.error, "invalid_submission", what);
    }
    assert.equal((await store.list()).length, 0, "nothing invalid was written");

    const sol = await service.submit(token, validBody({ chain: "solana", address: SOL_ADDRESS }));
    assert.ok(sol.ok);
    assert.equal(sol.submission.address.value, SOL_ADDRESS, "Solana base58 is case-sensitive and kept as-is");
  });
});

test("one pending submission per user per address; a different user can still submit for it", async () => {
  await withEnv(async ({ service, account }) => {
    const alice = await account("alice@example.com");
    const bob = await account("bob@example.com");
    assert.ok((await service.submit(alice.token, validBody())).ok);
    // Same address in a different case is the same address.
    const dup = await service.submit(alice.token, validBody({ address: ETH_ADDRESS.toLowerCase(), name: "Something else" }));
    assert.equal(!dup.ok && dup.error, "duplicate_submission");
    assert.ok((await service.submit(bob.token, validBody())).ok);
  });
});

test("only moderators and admins can see the queue or review; a plain user gets forbidden", async () => {
  await withEnv(async ({ service, account }) => {
    const alice = await account("alice@example.com");
    const submitted = await service.submit(alice.token, validBody());
    assert.ok(submitted.ok);

    const queue = await service.listForReview(alice.token);
    assert.equal(!queue.ok && queue.error, "forbidden");
    const confirm = await service.confirm(alice.token, submitted.submission.id);
    assert.equal(!confirm.ok && confirm.error, "forbidden");
    const reject = await service.reject(alice.token, submitted.submission.id, "no");
    assert.equal(!reject.ok && reject.error, "forbidden");
    assert.equal(!(await service.listForReview(null)).ok, true);

    const admin = await account("root@example.com", "admin");
    const adminQueue = await service.listForReview(admin.token);
    assert.ok(adminQueue.ok, "admin passes the moderator check");
    assert.equal(adminQueue.submissions.length, 1);
  });
});

test("a moderator confirms a community submission; the confirmer's id is recorded", async () => {
  await withEnv(async ({ service, account, clock }) => {
    const alice = await account("alice@example.com");
    const mod = await account("mod@example.com", "moderator");
    const submitted = await service.submit(alice.token, validBody());
    assert.ok(submitted.ok);

    clock.advance(60_000);
    const confirmed = await service.confirm(mod.token, submitted.submission.id);
    assert.ok(confirmed.ok);
    assert.equal(confirmed.submission.status, "confirmed");
    assert.ok(confirmed.submission.status === "confirmed");
    assert.equal(confirmed.submission.reviewedBy, mod.user.id);
    assert.equal(confirmed.submission.reviewedAt, clock.now().toISOString());

    const queue = await service.listForReview(mod.token);
    assert.ok(queue.ok);
    assert.equal(queue.submissions.length, 0, "confirmed submissions leave the queue");
    const done = await service.listForReview(mod.token, "confirmed");
    assert.ok(done.ok);
    assert.equal(done.submissions.length, 1);

    const again = await service.confirm(mod.token, submitted.submission.id);
    assert.equal(!again.ok && again.error, "already_reviewed");
    const missing = await service.confirm(mod.token, "no-such-id");
    assert.equal(!missing.ok && missing.error, "not_found");
  });
});

test("a moderator can't review their own submission — it takes a second person", async () => {
  await withEnv(async ({ service, account }) => {
    const mod = await account("mod@example.com", "moderator");
    const other = await account("mod2@example.com", "moderator");
    const mine = await service.submit(mod.token, validBody());
    assert.ok(mine.ok);

    const self = await service.confirm(mod.token, mine.submission.id);
    assert.equal(!self.ok && self.error, "own_submission");
    const selfReject = await service.reject(mod.token, mine.submission.id, "changed my mind");
    assert.equal(!selfReject.ok && selfReject.error, "own_submission");

    assert.ok((await service.confirm(other.token, mine.submission.id)).ok);
  });
});

test("rejecting needs a reason, which the submitter then sees in their own list", async () => {
  await withEnv(async ({ service, account }) => {
    const alice = await account("alice@example.com");
    const mod = await account("mod@example.com", "moderator");
    const submitted = await service.submit(alice.token, validBody());
    assert.ok(submitted.ok);

    const noReason = await service.reject(mod.token, submitted.submission.id, "   ");
    assert.equal(!noReason.ok && noReason.error, "invalid_submission");

    const rejected = await service.reject(mod.token, submitted.submission.id, "source doesn't mention this address");
    assert.ok(rejected.ok);
    assert.equal(rejected.submission.status, "rejected");

    const mine = await service.listMine(alice.token);
    assert.ok(mine.ok);
    assert.equal(mine.submissions.length, 1);
    const [only] = mine.submissions;
    assert.ok(only?.status === "rejected");
    assert.equal(only.rejectionReason, "source doesn't mention this address");

    // After a rejection the submitter may try again (with a better source).
    assert.ok((await service.submit(alice.token, validBody())).ok);
    const cantConfirmRejected = await service.confirm(mod.token, submitted.submission.id);
    assert.equal(!cantConfirmRejected.ok && cantConfirmRejected.error, "already_reviewed");
  });
});

test("a demoted moderator loses review rights on the very next request", async () => {
  await withEnv(async ({ service, account, accounts }) => {
    const alice = await account("alice@example.com");
    const mod = await account("mod@example.com", "moderator");
    const submitted = await service.submit(alice.token, validBody());
    assert.ok(submitted.ok);

    assert.ok((await accounts.setRoleAsOperator("mod@example.com", "user")).ok);
    const confirm = await service.confirm(mod.token, submitted.submission.id);
    assert.equal(!confirm.ok && confirm.error, "forbidden");
  });
});

test("two moderators reviewing the same submission at once: exactly one decision lands", async () => {
  await withEnv(async ({ service, account, store }) => {
    const alice = await account("alice@example.com");
    const m1 = await account("m1@example.com", "moderator");
    const m2 = await account("m2@example.com", "moderator");
    const submitted = await service.submit(alice.token, validBody());
    assert.ok(submitted.ok);

    const [a, b] = await Promise.all([
      service.confirm(m1.token, submitted.submission.id),
      service.reject(m2.token, submitted.submission.id, "duplicate of an existing label"),
    ]);
    assert.equal([a.ok, b.ok].filter(Boolean).length, 1, "exactly one review succeeds");
    const loser = a.ok ? b : a;
    assert.equal(!loser.ok && loser.error, "already_reviewed");
    const stored = await store.get(submitted.submission.id);
    assert.equal(stored?.status, a.ok ? "confirmed" : "rejected");
  });
});
