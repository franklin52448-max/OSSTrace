import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalAddress } from "../src/address.ts";
import { checkLabelText } from "../src/service.ts";
import { PRIVATE_LABEL_MAX_LENGTH } from "../src/types.ts";
import { ETH_ADDR, GOOD_PASSWORD, SOL_ADDR, withStack } from "./helpers.ts";

async function newUser(stack: Parameters<Parameters<typeof withStack>[0]>[0], email: string): Promise<string> {
  const res = await stack.accounts.signup(email, GOOD_PASSWORD);
  assert.ok(res.ok);
  return res.session.token;
}

test("canonicalAddress: Ethereum is lowercased (checksum case is not identity), Solana is kept exact", () => {
  assert.equal(canonicalAddress("ethereum", "  0x00000000219AB540356cBB839Cbe05303d7705Fa "), ETH_ADDR);
  assert.equal(canonicalAddress("ethereum", "0x1234"), null);
  assert.equal(canonicalAddress("ethereum", "0xzz000000219ab540356cbb839cbe05303d7705fa"), null);
  assert.equal(canonicalAddress("ethereum", SOL_ADDR), null);
  assert.equal(canonicalAddress("solana", SOL_ADDR), SOL_ADDR);
  // Lowercasing a base58 address names a different account, so it must not match the original.
  assert.notEqual(canonicalAddress("solana", SOL_ADDR.toLowerCase()), SOL_ADDR);
  assert.equal(canonicalAddress("solana", "0OIl" + SOL_ADDR.slice(4)), null);
  assert.equal(canonicalAddress("solana", ETH_ADDR), null);
});

test("checkLabelText: free text, no source needed, but one non-empty line within the length cap", () => {
  assert.equal(checkLabelText("scammer from discord 🚩"), null);
  assert.equal(checkLabelText("x".repeat(PRIVATE_LABEL_MAX_LENGTH)), null);
  // Counted in code points, so an emoji-heavy label isn't penalised for UTF-16 surrogate pairs.
  assert.equal(checkLabelText("🚩".repeat(PRIVATE_LABEL_MAX_LENGTH)), null);
  assert.match(checkLabelText("x".repeat(PRIVATE_LABEL_MAX_LENGTH + 1)) ?? "", /at most/);
  assert.match(checkLabelText("   ") ?? "", /empty/);
  assert.match(checkLabelText("two\nlines") ?? "", /single line/);
  assert.match(checkLabelText(42) ?? "", /string/);
  assert.match(checkLabelText(null) ?? "", /string/);
});

test("set → get → list → remove through the real service, label trimmed and timestamped by the clock", async () => {
  await withStack(async (stack) => {
    const token = await newUser(stack, "a@example.com");
    const created = await stack.service.set(token, "ethereum", ETH_ADDR.toUpperCase().replace("0X", "0x"), "  my cold wallet  ");
    assert.ok(created.ok);
    assert.equal(created.created, true);
    assert.deepEqual(created.label, {
      chain: "ethereum",
      address: ETH_ADDR,
      label: "my cold wallet",
      createdAt: "2026-10-21T12:00:00.000Z",
      updatedAt: "2026-10-21T12:00:00.000Z",
    });
    // No owner id in what's returned: the response can't carry anyone's identity.
    assert.equal("userId" in created.label, false);

    stack.clock.advance(60_000);
    const updated = await stack.service.set(token, "ethereum", ETH_ADDR, "renamed");
    assert.ok(updated.ok && !updated.created);
    assert.equal(updated.label.updatedAt, "2026-10-21T12:01:00.000Z");

    const got = await stack.service.get(token, "ethereum", ETH_ADDR);
    assert.ok(got.ok);
    assert.equal(got.label?.label, "renamed");

    const list = await stack.service.list(token);
    assert.ok(list.ok);
    assert.equal(list.labels.length, 1);

    assert.deepEqual(await stack.service.remove(token, "ethereum", ETH_ADDR), { ok: true });
    const gone = await stack.service.get(token, "ethereum", ETH_ADDR);
    assert.ok(gone.ok);
    assert.equal(gone.label, null);
    const again = await stack.service.remove(token, "ethereum", ETH_ADDR);
    assert.equal(again.ok, false);
    assert.equal(!again.ok && again.error, "not_found");
  });
});

test("every operation refuses a missing, forged, logged-out or expired session — before looking at anything else", async () => {
  await withStack(async (stack) => {
    const token = await newUser(stack, "a@example.com");
    assert.ok((await stack.service.set(token, "ethereum", ETH_ADDR, "mine")).ok);

    const loggedOut = await newUser(stack, "b@example.com");
    await stack.accounts.logout(loggedOut);

    const bad: (string | null | undefined)[] = [null, undefined, "", "ots_forged", token + "x", token.slice(0, -1), loggedOut];
    for (const t of bad) {
      for (const result of [
        await stack.service.get(t, "ethereum", ETH_ADDR),
        await stack.service.list(t),
        await stack.service.set(t, "ethereum", ETH_ADDR, "hijack"),
        await stack.service.remove(t, "ethereum", ETH_ADDR),
        // Even invalid input gets "unauthenticated", so an anonymous caller learns nothing.
        await stack.service.get(t, "bitcoin", "nope"),
      ]) {
        assert.equal(result.ok, false);
        assert.equal(!result.ok && result.error, "unauthenticated");
      }
    }

    // Past the session's absolute expiry, the real accounts service rejects the token.
    stack.clock.advance(30 * 24 * 60 * 60 * 1000);
    const expired = await stack.service.list(token);
    assert.equal(!expired.ok && expired.error, "unauthenticated");
  });
});

test("input errors (after auth): unknown chain, malformed address, bad label", async () => {
  await withStack(async (stack) => {
    const token = await newUser(stack, "a@example.com");
    const chain = await stack.service.set(token, "bitcoin", ETH_ADDR, "x");
    assert.equal(!chain.ok && chain.error, "invalid_chain");
    const address = await stack.service.set(token, "ethereum", "0xnope", "x");
    assert.equal(!address.ok && address.error, "invalid_address");
    const label = await stack.service.set(token, "ethereum", ETH_ADDR, "");
    assert.equal(!label.ok && label.error, "invalid_label");
    const list = await stack.service.list(token);
    assert.ok(list.ok && list.labels.length === 0);
  });
});

test("the per-user limit surfaces as limit_reached", async () => {
  await withStack(
    async (stack) => {
      const token = await newUser(stack, "a@example.com");
      assert.ok((await stack.service.set(token, "ethereum", ETH_ADDR, "one")).ok);
      const over = await stack.service.set(token, "solana", SOL_ADDR, "two");
      assert.equal(!over.ok && over.error, "limit_reached");
    },
    { perUserLimit: 1 },
  );
});
