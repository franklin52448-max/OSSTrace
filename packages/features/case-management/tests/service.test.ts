import { test } from "node:test";
import assert from "node:assert/strict";
import { ETH_ADDR, ETH_ADDR_2, ETH_ADDR_CHECKSUMMED, SOL_ADDR, withStack } from "./helpers.ts";

const MINUTE = 60_000;

test("full lifecycle through the real service: create → add items → edit → close (frozen) → reopen → delete", async () =>
  withStack(async ({ service, account, clock }) => {
    const { token } = await account("investigator@example.com");

    const created = await service.create(token, { title: "  Drainer   cluster  ", description: "Funding pattern\r\nlooks shared." });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.case.title, "Drainer cluster", "title is one line, whitespace collapsed");
    assert.equal(created.case.description, "Funding pattern\nlooks shared.", "description keeps its line break, normalized");
    assert.equal(created.case.status, "open");
    assert.equal(created.case.closedAt, null);
    assert.equal(created.case.createdAt, "2026-10-22T12:00:00.000Z");
    assert.equal("ownedBy" in created.case, false, "responses never carry an owner id");
    const id = created.case.id;

    clock.advance(MINUTE);
    const eth = await service.addItem(token, id, { chain: "ethereum", address: ` ${ETH_ADDR_CHECKSUMMED} `, note: "first hop" });
    assert.equal(eth.ok, true);
    if (!eth.ok) return;
    assert.equal(eth.item.address, ETH_ADDR, "Ethereum address stored in canonical (lowercase) form");
    assert.equal(eth.item.addedAt, "2026-10-22T12:01:00.000Z");
    const sol = await service.addItem(token, id, { chain: "solana", address: SOL_ADDR });
    assert.equal(sol.ok, true);
    if (sol.ok) {
      assert.equal(sol.item.address, SOL_ADDR, "Solana base58 kept exact");
      assert.equal(sol.item.note, "", "a note is optional");
    }

    clock.advance(MINUTE);
    const edited = await service.updateItem(token, id, eth.item.id, { note: "first hop — confirmed via Tracer" });
    assert.equal(edited.ok, true);
    if (edited.ok) {
      assert.equal(edited.item.note, "first hop — confirmed via Tracer");
      assert.equal(edited.item.addedAt, "2026-10-22T12:01:00.000Z");
      assert.equal(edited.item.updatedAt, "2026-10-22T12:02:00.000Z");
    }

    const got = await service.get(token, id);
    assert.equal(got.ok, true);
    if (got.ok) {
      assert.deepEqual(got.items.map((i) => i.chain), ["ethereum", "solana"], "items in the order they were added");
      assert.equal(got.case.updatedAt, "2026-10-22T12:02:00.000Z", "editing an item counts as working on the case");
    }

    const renamed = await service.update(token, id, { title: "Drainer cluster (Oct)" });
    assert.equal(renamed.ok, true);
    if (renamed.ok) assert.equal(renamed.case.description, "Funding pattern\nlooks shared.", "an omitted field is left unchanged");

    clock.advance(MINUTE);
    const closed = await service.close(token, id);
    assert.equal(closed.ok, true);
    if (closed.ok) {
      assert.equal(closed.case.status, "closed");
      assert.equal(closed.case.closedAt, "2026-10-22T12:03:00.000Z");
    }

    // A closed case is read-only: every change is refused with case_closed, and nothing changes.
    for (const attempt of [
      await service.update(token, id, { title: "changed while closed" }),
      await service.addItem(token, id, { chain: "ethereum", address: ETH_ADDR_2 }),
      await service.updateItem(token, id, eth.item.id, { note: "changed while closed" }),
      await service.removeItem(token, id, eth.item.id),
      await service.close(token, id),
    ]) {
      assert.equal(attempt.ok, false);
      if (!attempt.ok) assert.equal(attempt.error, "case_closed");
    }
    const frozen = await service.get(token, id);
    if (frozen.ok) {
      assert.equal(frozen.case.title, "Drainer cluster (Oct)");
      assert.equal(frozen.items.length, 2);
    }

    const reopened = await service.reopen(token, id);
    assert.equal(reopened.ok, true);
    if (reopened.ok) {
      assert.equal(reopened.case.status, "open");
      assert.equal(reopened.case.closedAt, null);
    }
    const reopenAgain = await service.reopen(token, id);
    assert.equal(reopenAgain.ok, false);
    if (!reopenAgain.ok) assert.equal(reopenAgain.error, "case_not_closed");

    const removedItem = await service.removeItem(token, id, sol.ok ? sol.item.id : "");
    assert.equal(removedItem.ok, true);
    const afterRemove = await service.get(token, id);
    if (afterRemove.ok) assert.deepEqual(afterRemove.items.map((i) => i.chain), ["ethereum"]);

    assert.equal((await service.remove(token, id)).ok, true);
    const gone = await service.get(token, id);
    assert.equal(gone.ok, false);
    if (!gone.ok) assert.equal(gone.error, "not_found");
    const list = await service.list(token, undefined);
    assert.deepEqual(list, { ok: true, cases: [] });
  }));

test("list: your own cases only, most recently worked-on first, with item counts and a status filter", async () =>
  withStack(async ({ service, account, clock }) => {
    const { token } = await account("investigator@example.com");
    const a = await service.create(token, { title: "A" });
    clock.advance(MINUTE);
    const b = await service.create(token, { title: "B" });
    if (!a.ok || !b.ok) throw new Error("setup failed");
    clock.advance(MINUTE);
    await service.addItem(token, a.case.id, { chain: "ethereum", address: ETH_ADDR });
    await service.addItem(token, a.case.id, { chain: "ethereum", address: ETH_ADDR_2 });

    const all = await service.list(token, undefined);
    assert.equal(all.ok, true);
    if (all.ok) {
      assert.deepEqual(all.cases.map((c) => c.title), ["A", "B"], "A was worked on most recently");
      assert.deepEqual(all.cases.map((c) => c.itemCount), [2, 0]);
    }

    clock.advance(MINUTE);
    await service.close(token, b.case.id);
    const open = await service.list(token, "open");
    if (open.ok) assert.deepEqual(open.cases.map((c) => c.title), ["A"]);
    const closed = await service.list(token, "closed");
    if (closed.ok) assert.deepEqual(closed.cases.map((c) => c.title), ["B"]);
    const bad = await service.list(token, "archived");
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.error, "invalid_case");
  }));

test("ISOLATION: another user — even a moderator or an admin — can't read, list, change or delete your case", async () =>
  withStack(async ({ service, account }) => {
    const bob = await account("bob@example.com");
    const BOB_TITLE = "bob-secret-investigation-4e1d";
    const BOB_NOTE = "bob-secret-informant-note-9a7c";
    const created = await service.create(bob.token, { title: BOB_TITLE, description: "bob-secret-description" });
    if (!created.ok) throw new Error("setup failed");
    const caseId = created.case.id;
    const added = await service.addItem(bob.token, caseId, { chain: "ethereum", address: ETH_ADDR, note: BOB_NOTE });
    if (!added.ok) throw new Error("setup failed");
    const itemId = added.item.id;

    const alice = await account("alice@example.com");
    const mod = await account("mod@example.com", "moderator");
    const admin = await account("admin@example.com", "admin");

    for (const intruder of [alice, mod, admin]) {
      const t = intruder.token;
      const attempts = [
        await service.get(t, caseId),
        await service.update(t, caseId, { title: "hijacked", ownedBy: intruder.user.id }),
        await service.close(t, caseId),
        await service.reopen(t, caseId),
        await service.addItem(t, caseId, { chain: "ethereum", address: ETH_ADDR_2, note: "planted" }),
        await service.updateItem(t, caseId, itemId, { note: "hijacked" }),
        await service.removeItem(t, caseId, itemId),
        await service.remove(t, caseId),
      ];
      for (const attempt of attempts) {
        assert.equal(attempt.ok, false, `${intruder.user.role} got through`);
        // not_found, never forbidden: someone else's case is indistinguishable from no case at all.
        if (!attempt.ok) assert.equal(attempt.error, "not_found");
        assert.equal(JSON.stringify(attempt).includes(BOB_TITLE), false);
        assert.equal(JSON.stringify(attempt).includes(BOB_NOTE), false);
      }
      const list = await service.list(t, undefined);
      assert.deepEqual(list, { ok: true, cases: [] });
    }

    // Bob's case is exactly as he left it.
    const bobView = await service.get(bob.token, caseId);
    assert.equal(bobView.ok, true);
    if (bobView.ok) {
      assert.equal(bobView.case.title, BOB_TITLE);
      assert.equal(bobView.case.status, "open");
      assert.deepEqual(bobView.items.map((i) => i.note), [BOB_NOTE]);
    }
  }));

test("ISOLATION: an intruder's own case can't be used to reach someone else's item by id", async () =>
  withStack(async ({ service, account }) => {
    const bob = await account("bob@example.com");
    const bobCase = await service.create(bob.token, { title: "bob's" });
    if (!bobCase.ok) throw new Error("setup failed");
    const bobItem = await service.addItem(bob.token, bobCase.case.id, { chain: "solana", address: SOL_ADDR, note: "bob-only" });
    if (!bobItem.ok) throw new Error("setup failed");

    const alice = await account("alice@example.com");
    const aliceCase = await service.create(alice.token, { title: "alice's" });
    if (!aliceCase.ok) throw new Error("setup failed");

    const edit = await service.updateItem(alice.token, aliceCase.case.id, bobItem.item.id, { note: "hijacked" });
    assert.equal(edit.ok, false);
    if (!edit.ok) assert.equal(edit.error, "not_found");
    const remove = await service.removeItem(alice.token, aliceCase.case.id, bobItem.item.id);
    assert.equal(remove.ok, false);
    const aliceView = await service.get(alice.token, aliceCase.case.id);
    if (aliceView.ok) assert.deepEqual(aliceView.items, []);
    const bobView = await service.get(bob.token, bobCase.case.id);
    if (bobView.ok) assert.deepEqual(bobView.items.map((i) => i.note), ["bob-only"]);
  }));

test("ISOLATION: two users can hold the same address in their own cases without seeing each other's notes", async () =>
  withStack(async ({ service, account }) => {
    const bob = await account("bob@example.com");
    const alice = await account("alice@example.com");
    const b = await service.create(bob.token, { title: "B" });
    const a = await service.create(alice.token, { title: "A" });
    if (!a.ok || !b.ok) throw new Error("setup failed");
    assert.equal((await service.addItem(bob.token, b.case.id, { chain: "ethereum", address: ETH_ADDR, note: "bob's view" })).ok, true);
    assert.equal((await service.addItem(alice.token, a.case.id, { chain: "ethereum", address: ETH_ADDR, note: "alice's view" })).ok, true);
    const aliceView = await service.get(alice.token, a.case.id);
    if (aliceView.ok) assert.deepEqual(aliceView.items.map((i) => i.note), ["alice's view"]);
    const bobView = await service.get(bob.token, b.case.id);
    if (bobView.ok) assert.deepEqual(bobView.items.map((i) => i.note), ["bob's view"]);
  }));

test("every operation refuses a missing, forged, logged-out or expired session — before looking at anything else", async () =>
  withStack(async ({ service, account, accounts, clock }) => {
    const bob = await account("bob@example.com");
    const created = await service.create(bob.token, { title: "bob's case" });
    if (!created.ok) throw new Error("setup failed");
    const caseId = created.case.id;

    const relogin = await accounts.login("bob@example.com", "correct horse battery staple");
    if (!relogin.ok) throw new Error("setup failed");
    await accounts.logout(bob.token);

    for (const token of [null, undefined, "", "ots_" + "A".repeat(43), "not-a-token", bob.token]) {
      const attempts = [
        await service.list(token, undefined),
        // Invalid input too: an anonymous caller never learns whether their input was well-formed.
        await service.create(token, { title: "" }),
        await service.get(token, caseId),
        await service.update(token, caseId, { title: "x" }),
        await service.close(token, caseId),
        await service.reopen(token, caseId),
        await service.remove(token, caseId),
        await service.addItem(token, caseId, { chain: "bitcoin", address: "nope" }),
        await service.updateItem(token, caseId, "whatever", { note: "x" }),
        await service.removeItem(token, caseId, "whatever"),
      ];
      for (const attempt of attempts) {
        assert.equal(attempt.ok, false);
        if (!attempt.ok) assert.equal(attempt.error, "unauthenticated");
      }
    }

    // The live session still works — and nothing was changed by any of that.
    const live = await service.get(relogin.session.token, caseId);
    assert.equal(live.ok, true);
    if (live.ok) assert.equal(live.case.title, "bob's case");

    // Past the 30-day absolute expiry the session is rejected through the real accounts code path.
    clock.advance(30 * 24 * 60 * MINUTE + 1);
    const expired = await service.list(relogin.session.token, undefined);
    assert.equal(expired.ok, false);
    if (!expired.ok) assert.equal(expired.error, "unauthenticated");
  }));

test("validation: title, description, chain, address and note are all checked", async () =>
  withStack(async ({ service, account }) => {
    const { token } = await account("investigator@example.com");
    const expectError = (result: { ok: boolean; error?: string }, error: string): void => {
      assert.equal(result.ok, false);
      assert.equal(result.error, error);
    };

    expectError(await service.create(token, {}), "invalid_case");
    expectError(await service.create(token, { title: "   " }), "invalid_case");
    expectError(await service.create(token, { title: "x".repeat(141) }), "invalid_case");
    expectError(await service.create(token, { title: 42 }), "invalid_case");
    expectError(await service.create(token, { title: "ok", description: 7 }), "invalid_case");
    expectError(await service.create(token, { title: "ok", description: "x".repeat(8001) }), "invalid_case");
    expectError(await service.create(token, { title: "ok", description: "bell\u0007" }), "invalid_case");
    // A 140-code-point title of multi-byte characters is fine: limits count code points, not bytes.
    assert.equal((await service.create(token, { title: "🔍".repeat(140) })).ok, true);

    const created = await service.create(token, { title: "Validation case" });
    if (!created.ok) throw new Error("setup failed");
    const id = created.case.id;

    expectError(await service.update(token, id, {}), "invalid_case");
    expectError(await service.update(token, id, { title: "" }), "invalid_case");

    expectError(await service.addItem(token, id, { chain: "bitcoin", address: ETH_ADDR }), "invalid_chain");
    expectError(await service.addItem(token, id, { address: ETH_ADDR }), "invalid_chain");
    expectError(await service.addItem(token, id, { chain: "ethereum", address: "0x12" }), "invalid_address");
    expectError(await service.addItem(token, id, { chain: "ethereum", address: ETH_ADDR + "00" }), "invalid_address");
    expectError(await service.addItem(token, id, { chain: "ethereum", address: SOL_ADDR }), "invalid_address");
    expectError(await service.addItem(token, id, { chain: "solana", address: ETH_ADDR }), "invalid_address");
    expectError(await service.addItem(token, id, { chain: "solana", address: "0OIl" + SOL_ADDR.slice(4) }), "invalid_address");
    expectError(await service.addItem(token, id, { chain: "solana", address: 123 }), "invalid_address");
    expectError(await service.addItem(token, id, { chain: "ethereum", address: ETH_ADDR, note: "x".repeat(2001) }), "invalid_item");
    expectError(await service.addItem(token, id, { chain: "ethereum", address: ETH_ADDR, note: ["array"] }), "invalid_item");

    const ok = await service.addItem(token, id, { chain: "ethereum", address: ETH_ADDR, note: "line one\nline two" });
    assert.equal(ok.ok, true);
    if (!ok.ok) return;
    expectError(await service.updateItem(token, id, ok.item.id, {}), "invalid_item");
    expectError(await service.updateItem(token, id, "no-such-item", { note: "x" }), "not_found");
    expectError(await service.removeItem(token, id, "no-such-item"), "not_found");
    expectError(await service.get(token, "no-such-case"), "not_found");
    expectError(await service.get(token, ""), "not_found");
    // Clearing a note is allowed.
    const cleared = await service.updateItem(token, id, ok.item.id, { note: "" });
    assert.equal(cleared.ok, true);
  }));

test("one case holds an address once — in any spelling of it; the same address in a different case is fine", async () =>
  withStack(async ({ service, account }) => {
    const { token } = await account("investigator@example.com");
    const a = await service.create(token, { title: "A" });
    const b = await service.create(token, { title: "B" });
    if (!a.ok || !b.ok) throw new Error("setup failed");
    assert.equal((await service.addItem(token, a.case.id, { chain: "ethereum", address: ETH_ADDR })).ok, true);
    for (const spelling of [ETH_ADDR, ETH_ADDR_CHECKSUMMED, ETH_ADDR.toUpperCase().replace("0X", "0x"), `  ${ETH_ADDR}\n`]) {
      const dup = await service.addItem(token, a.case.id, { chain: "ethereum", address: spelling });
      assert.equal(dup.ok, false);
      if (!dup.ok) assert.equal(dup.error, "duplicate_item");
    }
    assert.equal((await service.addItem(token, b.case.id, { chain: "ethereum", address: ETH_ADDR_CHECKSUMMED })).ok, true);
  }));

test("limits surface as limit_reached: cases per account, items per case", async () =>
  withStack(
    async ({ service, account }) => {
      const { token } = await account("investigator@example.com");
      const first = await service.create(token, { title: "one" });
      assert.equal(first.ok, true);
      assert.equal((await service.create(token, { title: "two" })).ok, true);
      const third = await service.create(token, { title: "three" });
      assert.equal(third.ok, false);
      if (!third.ok) assert.equal(third.error, "limit_reached");
      if (!first.ok) return;
      assert.equal((await service.addItem(token, first.case.id, { chain: "ethereum", address: ETH_ADDR })).ok, true);
      const over = await service.addItem(token, first.case.id, { chain: "ethereum", address: ETH_ADDR_2 });
      assert.equal(over.ok, false);
      if (!over.ok) assert.equal(over.error, "limit_reached");
    },
    { casesPerUserLimit: 2, itemsPerCaseLimit: 1 },
  ));
