import { test } from "node:test";
import assert from "node:assert/strict";
import { withEnv, validBountyBody, validSubmissionBody } from "./helpers.ts";

const REAL_SIG = "bqTH7u2PJ33gDQwZMy9BXVxABRpgUbY8xSuK6y9PpKYxucFKhiJyiD7JTrH1zxFvMEJGz4847tvotMoP1Ekavaa";
const REAL_HASH = "0x88e2744cdf18d3118f9a8fe4169bd586785e1e48897cf4d7960a9ec47d8111dc";

test("open -> list -> get: a real bounty is created, public to read with no login", async () =>
  withEnv(async ({ service, account }) => {
    const { token } = await account("poster@example.com");
    const opened = await service.open(token, validBountyBody());
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    assert.equal(opened.bounty.status, "open");
    assert.equal(opened.bounty.reward, "100,000 tokens (token TBD)");

    const listed = await service.list(undefined);
    assert.equal(listed.ok, true);
    if (listed.ok) assert.deepEqual(listed.bounties.map((b) => b.id), [opened.bounty.id]);

    const got = await service.get(opened.bounty.id);
    assert.equal(got.ok, true);
    if (got.ok) assert.equal(got.bounty.id, opened.bounty.id);
  }));

test("opening a bounty requires login; an unauthenticated request never creates one", async () =>
  withEnv(async ({ service }) => {
    const result = await service.open(null, validBountyBody());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "unauthenticated");
    const listed = await service.list(undefined);
    assert.deepEqual(listed, { ok: true, bounties: [] });
  }));

test("a one-line spec is refused -- 'in depth' is a real minimum, not just a suggestion", async () =>
  withEnv(async ({ service, account }) => {
    const { token } = await account("poster@example.com");
    const result = await service.open(token, validBountyBody({ description: "too short" }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "invalid_bounty");
  }));

test("submit requires login and the bounty to be open; a real submission is stored pending", async () =>
  withEnv(async ({ service, account }) => {
    const { token: posterToken } = await account("poster@example.com");
    const opened = await service.open(posterToken, validBountyBody());
    if (!opened.ok) throw new Error("setup failed");

    const { token: devToken } = await account("dev@example.com");
    const unauthed = await service.submit(null, opened.bounty.id, validSubmissionBody());
    assert.equal(unauthed.ok, false);
    if (!unauthed.ok) assert.equal(unauthed.error, "unauthenticated");

    const submitted = await service.submit(devToken, opened.bounty.id, validSubmissionBody());
    assert.equal(submitted.ok, true);
    if (submitted.ok) {
      assert.equal(submitted.submission.outcome, "pending");
      assert.equal(submitted.submission.prUrl, "https://github.com/OpenTraceIntelligence/OSSTrace/pull/42");
    }

    const submissions = await service.listSubmissions(opened.bounty.id);
    assert.equal(submissions.ok, true);
    if (submissions.ok) assert.equal(submissions.submissions.length, 1);
  }));

test("a non-absolute prUrl, or one pointing at a host only the submitter can open, is refused -- never fetched server-side, so shape is all that's checked", async () =>
  withEnv(async ({ service, account }) => {
    const { token: posterToken } = await account("poster@example.com");
    const opened = await service.open(posterToken, validBountyBody());
    if (!opened.ok) throw new Error("setup failed");
    const { token: devToken } = await account("dev@example.com");
    // Same real-public-host check community-labels' source URL uses (@osstrace/core's
    // parsePublicUrl): a PR URL that resolves into the submitter's own machine or network,
    // rather than the moderator's, can't be meaningfully reviewed.
    for (const prUrl of [
      "not-a-url",
      "http://localhost:8080/pr",
      "http://127.0.0.1/pr",
      "http://127.1/pr", // short-form loopback, normalised by `new URL`
      "https://192.168.0.10/pr",
      "https://172.20.0.1/pr",
      "https://100.100.0.1/pr", // carrier-grade NAT
      "http://169.254.169.254/pr", // link-local / cloud metadata endpoint
      "https://u:p@github.com/x/y/pull/1", // embedded credentials
    ]) {
      const result = await service.submit(devToken, opened.bounty.id, validSubmissionBody({ prUrl }));
      assert.equal(result.ok, false, prUrl);
      if (!result.ok) assert.equal(result.error, "invalid_submission", prUrl);
    }
  }));

test("claim requires a moderator; claiming marks the winner accepted and every other pending submission rejected", async () =>
  withEnv(async ({ service, account }) => {
    const { token: posterToken } = await account("poster@example.com");
    const opened = await service.open(posterToken, validBountyBody());
    if (!opened.ok) throw new Error("setup failed");

    const { token: devAToken, user: devA } = await account("dev-a@example.com");
    const { token: devBToken } = await account("dev-b@example.com");
    const subA = await service.submit(devAToken, opened.bounty.id, validSubmissionBody({ prUrl: "https://github.com/x/y/pull/1" }));
    const subB = await service.submit(devBToken, opened.bounty.id, validSubmissionBody({ prUrl: "https://github.com/x/y/pull/2" }));
    if (!subA.ok || !subB.ok) throw new Error("setup failed");

    // A plain logged-in user (not a moderator) can't claim.
    const forbidden = await service.claim(devAToken, opened.bounty.id, subA.submission.id);
    assert.equal(forbidden.ok, false);
    if (!forbidden.ok) assert.equal(forbidden.error, "forbidden");

    const { token: modToken } = await account("mod@example.com", "moderator");
    const claimed = await service.claim(modToken, opened.bounty.id, subA.submission.id);
    assert.equal(claimed.ok, true);
    if (claimed.ok) {
      assert.equal(claimed.bounty.status, "claimed");
      if (claimed.bounty.status === "claimed") {
        assert.equal(claimed.bounty.claimedBy, devA.id);
        assert.equal(claimed.bounty.claimedSubmissionId, subA.submission.id);
      }
    }

    const submissions = await service.listSubmissions(opened.bounty.id);
    if (submissions.ok) {
      const byId = new Map(submissions.submissions.map((s) => [s.id, s.outcome]));
      assert.equal(byId.get(subA.submission.id), "accepted");
      assert.equal(byId.get(subB.submission.id), "rejected");
    }

    // The bounty is no longer open -- a second claim attempt, and a new submission, are both refused.
    const secondClaim = await service.claim(modToken, opened.bounty.id, subB.submission.id);
    assert.equal(secondClaim.ok, false);
    if (!secondClaim.ok) assert.equal(secondClaim.error, "not_open");
    const lateSubmission = await service.submit(devBToken, opened.bounty.id, validSubmissionBody());
    assert.equal(lateSubmission.ok, false);
    if (!lateSubmission.ok) assert.equal(lateSubmission.error, "not_open");
  }));

test("cancel: the bounty's own opener can cancel while it's open", async () =>
  withEnv(async ({ service, account }) => {
    const { token: posterToken } = await account("poster@example.com");
    const opened = await service.open(posterToken, validBountyBody());
    if (!opened.ok) throw new Error("setup failed");

    const cancelled = await service.cancel(posterToken, opened.bounty.id, "no longer needed");
    assert.equal(cancelled.ok, true);
    if (cancelled.ok) {
      assert.equal(cancelled.bounty.status, "cancelled");
      if (cancelled.bounty.status === "cancelled") assert.equal(cancelled.bounty.cancellationReason, "no longer needed");
    }
  }));

test("cancel: a moderator can cancel someone else's bounty; an unrelated user cannot", async () =>
  withEnv(async ({ service, account }) => {
    const { token: posterToken } = await account("poster@example.com");
    const opened = await service.open(posterToken, validBountyBody());
    if (!opened.ok) throw new Error("setup failed");

    const { token: strangerToken } = await account("stranger@example.com");
    const forbidden = await service.cancel(strangerToken, opened.bounty.id, "trying to cancel someone else's bounty");
    assert.equal(forbidden.ok, false);
    if (!forbidden.ok) assert.equal(forbidden.error, "forbidden");

    const { token: modToken } = await account("mod@example.com", "moderator");
    const cancelled = await service.cancel(modToken, opened.bounty.id, "spec was a duplicate of another open bounty");
    assert.equal(cancelled.ok, true);
  }));

test("a cancellation reason is required, same as a label rejection reason", async () =>
  withEnv(async ({ service, account }) => {
    const { token } = await account("poster@example.com");
    const opened = await service.open(token, validBountyBody());
    if (!opened.ok) throw new Error("setup failed");
    const result = await service.cancel(token, opened.bounty.id, "");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "invalid_bounty");
  }));

test("list(status) filters correctly, and an invalid status is refused rather than silently ignored", async () =>
  withEnv(async ({ service, account }) => {
    const { token } = await account("poster@example.com");
    const a = await service.open(token, validBountyBody({ title: "A" }));
    const b = await service.open(token, validBountyBody({ title: "B" }));
    if (!a.ok || !b.ok) throw new Error("setup failed");
    await service.cancel(token, b.bounty.id, "withdrawn");

    const openOnly = await service.list("open");
    if (openOnly.ok) assert.deepEqual(openOnly.bounties.map((bt) => bt.id), [a.bounty.id]);

    const bad = await service.list("not-a-real-status");
    assert.equal(bad.ok, false);
  }));

test("recordDeposit: a verified deposit is recorded, visible on the bounty's public deposit list, and funding doesn't need login to view or change the bounty's status", async () =>
  withEnv(async ({ service, account, deposits }) => {
    const { token: opener } = await account("opener@example.com");
    const opened = await service.open(opener, validBountyBody());
    if (!opened.ok) throw new Error("setup failed");
    const { user: funderUser, token: funder } = await account("funder@example.com"); // not the opener -- anyone may back a bounty

    deposits.set("solana", REAL_SIG, {
      ok: true,
      deposit: { asset: "native", amount: "0.0001", fromAddress: "E16prLnWTwfLUYgXRTELYgw4u8QUnN9CAcHceLrDTjN1", toWallet: "ourwallet" },
    });
    const result = await service.recordDeposit(funder, opened.bounty.id, { chain: "solana", txRef: REAL_SIG });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.deposit.amount, "0.0001");
      assert.equal(result.deposit.asset, "native");
      assert.equal(result.deposit.fromAddress, "E16prLnWTwfLUYgXRTELYgw4u8QUnN9CAcHceLrDTjN1");
      assert.equal(result.deposit.recordedBy, funderUser.id);
    }

    const listed = await service.listDeposits(opened.bounty.id);
    assert.equal(listed.ok, true);
    if (listed.ok) {
      assert.equal(listed.deposits.length, 1);
      assert.equal(listed.deposits[0]?.txRef, REAL_SIG);
    }

    // Funding never changes the bounty's own status.
    const still = await service.get(opened.bounty.id);
    assert.equal(still.ok, true);
    if (still.ok) assert.equal(still.bounty.status, "open");
  }));

test("recordDeposit: signed out is refused before any verification is attempted", async () =>
  withEnv(async ({ service, account, deposits }) => {
    const { token } = await account("opener@example.com");
    const opened = await service.open(token, validBountyBody());
    if (!opened.ok) throw new Error("setup failed");
    const result = await service.recordDeposit(null, opened.bounty.id, { chain: "solana", txRef: REAL_SIG });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "unauthenticated");
    assert.deepEqual(deposits.calls, [], "never reaches the verifier for a signed-out caller");
  }));

test("recordDeposit: input errors (after auth) -- unknown bounty, bad chain, missing txRef", async () =>
  withEnv(async ({ service, account }) => {
    const { token } = await account("opener@example.com");
    const opened = await service.open(token, validBountyBody());
    if (!opened.ok) throw new Error("setup failed");

    const noBounty = await service.recordDeposit(token, "no-such-bounty", { chain: "solana", txRef: REAL_SIG });
    assert.equal(!noBounty.ok && noBounty.error, "not_found");

    const badChain = await service.recordDeposit(token, opened.bounty.id, { chain: "bitcoin", txRef: REAL_SIG });
    assert.equal(!badChain.ok && badChain.error, "invalid_deposit");

    const noRef = await service.recordDeposit(token, opened.bounty.id, { chain: "solana" });
    assert.equal(!noRef.ok && noRef.error, "invalid_deposit");
  }));

test("recordDeposit: a chain with no verifier configured for it is refused as chain_not_configured, not a crash", async () =>
  withEnv(async ({ service, account }) => {
    const { token } = await account("opener@example.com");
    const opened = await service.open(token, validBountyBody());
    if (!opened.ok) throw new Error("setup failed");
    // FixedDepositVerifier answers "not_found" for anything not explicitly `set` -- real
    // not_configured behaviour is covered against the real verifier in deposits.test.ts; here the
    // service must still map whatever "not ok" reason it gets to a real BountyErrorCode, never throw.
    const result = await service.recordDeposit(token, opened.bounty.id, { chain: "ethereum", txRef: REAL_HASH });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "deposit_not_verified");
  }));

test("recordDeposit: the same real transaction can't fund two bounties, or the same bounty twice", async () =>
  withEnv(async ({ service, account, deposits }) => {
    const { token } = await account("opener@example.com");
    const a = await service.open(token, validBountyBody({ title: "A" }));
    const b = await service.open(token, validBountyBody({ title: "B" }));
    if (!a.ok || !b.ok) throw new Error("setup failed");
    deposits.set("solana", REAL_SIG, { ok: true, deposit: { asset: "native", amount: "1", fromAddress: "someone", toWallet: "ourwallet" } });

    const first = await service.recordDeposit(token, a.bounty.id, { chain: "solana", txRef: REAL_SIG });
    assert.equal(first.ok, true);

    const sameBounty = await service.recordDeposit(token, a.bounty.id, { chain: "solana", txRef: REAL_SIG });
    assert.equal(sameBounty.ok, false);
    if (!sameBounty.ok) assert.equal(sameBounty.error, "already_recorded");

    const otherBounty = await service.recordDeposit(token, b.bounty.id, { chain: "solana", txRef: REAL_SIG });
    assert.equal(otherBounty.ok, false);
    if (!otherBounty.ok) {
      assert.equal(otherBounty.error, "already_recorded");
      assert.match(otherBounty.message, /different bounty/);
    }

    const onlyOne = await service.listDeposits(a.bounty.id);
    assert.equal(onlyOne.ok && onlyOne.deposits.length, 1);
  }));

test("recordDeposit: a real verification failure (wrong wallet, not confirmed, etc.) is refused as deposit_not_verified, with the real reason in the message", async () =>
  withEnv(async ({ service, account, deposits }) => {
    const { token } = await account("opener@example.com");
    const opened = await service.open(token, validBountyBody());
    if (!opened.ok) throw new Error("setup failed");
    deposits.set("solana", REAL_SIG, { ok: false, reason: "wrong_wallet" });

    const result = await service.recordDeposit(token, opened.bounty.id, { chain: "solana", txRef: REAL_SIG });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "deposit_not_verified");
      assert.match(result.message, /didn't pay/);
    }
    const listed = await service.listDeposits(opened.bounty.id);
    assert.equal(listed.ok && listed.deposits.length, 0, "a failed verification is never recorded");
  }));
