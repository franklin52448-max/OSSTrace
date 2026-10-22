import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { call, ETH_ADDR, ETH_ADDR_2, ETH_ADDR_CHECKSUMMED, GOOD_PASSWORD, signup, SOL_ADDR, WEB_ORIGIN, withServer, type CallResult } from "./helpers.ts";

test("full flow over real HTTP: 401 without a session, then create → add items → edit → close → reopen → delete", async () => {
  await withServer(async (base) => {
    assert.equal((await call(base, "GET", "/cases")).status, 401);
    assert.equal((await call(base, "POST", "/cases", { body: { title: "x" } })).status, 401);

    const me = await signup(base, "investigator@example.com");
    const t = { token: me.token };
    assert.deepEqual((await call(base, "GET", "/cases", t)).body.cases, []);

    const created = await call(base, "POST", "/cases", { ...t, body: { title: "Bridge exploit follow-up", description: "Where did the funds go?" } });
    assert.equal(created.status, 201);
    assert.equal(created.body.case.status, "open");
    assert.equal(created.body.case.ownedBy, undefined, "no owner id on the wire");
    const id = created.body.case.id as string;

    const eth = await call(base, "POST", `/cases/${id}/items`, { ...t, body: { chain: "ethereum", address: ETH_ADDR_CHECKSUMMED, note: "exploiter" } });
    assert.equal(eth.status, 201);
    assert.equal(eth.body.item.address, ETH_ADDR);
    const sol = await call(base, "POST", `/cases/${id}/items`, { ...t, body: { chain: "solana", address: SOL_ADDR } });
    assert.equal(sol.status, 201);
    const dup = await call(base, "POST", `/cases/${id}/items`, { ...t, body: { chain: "ethereum", address: ETH_ADDR } });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, "duplicate_item");

    const note = await call(base, "PATCH", `/cases/${id}/items/${eth.body.item.id}`, { ...t, body: { note: "exploiter (deployer of the attack contract)" } });
    assert.equal(note.status, 200);
    assert.equal(note.body.item.note, "exploiter (deployer of the attack contract)");

    const renamed = await call(base, "PATCH", `/cases/${id}`, { ...t, body: { title: "Bridge exploit — funds trail" } });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.case.title, "Bridge exploit — funds trail");

    const detail = await call(base, "GET", `/cases/${id}`, t);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.items.length, 2);
    assert.equal(detail.text.includes(me.id), false, "the owner's own responses don't carry their id either");

    const list = await call(base, "GET", "/cases", t);
    assert.deepEqual(list.body.cases.map((c: { itemCount: number }) => c.itemCount), [2]);

    assert.equal((await call(base, "POST", `/cases/${id}/close`, t)).status, 200);
    const frozen = await call(base, "POST", `/cases/${id}/items`, { ...t, body: { chain: "ethereum", address: ETH_ADDR_2 } });
    assert.equal(frozen.status, 409);
    assert.equal(frozen.body.error, "case_closed");
    assert.equal((await call(base, "POST", `/cases/${id}/close`, t)).status, 409);
    assert.deepEqual((await call(base, "GET", "/cases?status=closed", t)).body.cases.map((c: { id: string }) => c.id), [id]);
    assert.deepEqual((await call(base, "GET", "/cases?status=open", t)).body.cases, []);

    assert.equal((await call(base, "POST", `/cases/${id}/reopen`, t)).status, 200);
    assert.equal((await call(base, "POST", `/cases/${id}/reopen`, t)).status, 409);

    assert.equal((await call(base, "DELETE", `/cases/${id}/items/${sol.body.item.id}`, t)).status, 204);
    assert.equal((await call(base, "DELETE", `/cases/${id}/items/${sol.body.item.id}`, t)).status, 404);

    assert.equal((await call(base, "DELETE", `/cases/${id}`, t)).status, 204);
    assert.equal((await call(base, "DELETE", `/cases/${id}`, t)).status, 404);
    assert.equal((await call(base, "GET", `/cases/${id}`, t)).status, 404);
  });
});

/**
 * The property this package exists to guarantee (ADR 0011 §2–3). Bob builds a case; Alice — a
 * real, fully-authenticated user — tries every route and trick we could think of to read, change
 * or delete it. Then the same again as a moderator and as an admin, because no role unlocks
 * someone else's case. None may work, every attempt on Bob's case id must look exactly like a
 * case that doesn't exist, and no byte of Bob's data may appear in any response the intruder gets.
 */
test("ISOLATION: no other user — plain, moderator or admin — can read, list, change or delete a case, by any route or trick", async () => {
  await withServer(async (base, stack) => {
    const bob = await signup(base, "bob@example.com");
    const BOB_TITLE = "bob-secret-case-title-5b2e";
    const BOB_DESC = "bob-secret-case-description-c81f";
    const BOB_NOTE = "bob-secret-item-note-07da";
    const created = await call(base, "POST", "/cases", { token: bob.token, body: { title: BOB_TITLE, description: BOB_DESC } });
    assert.equal(created.status, 201);
    const caseId = created.body.case.id as string;
    const item = await call(base, "POST", `/cases/${caseId}/items`, { token: bob.token, body: { chain: "ethereum", address: ETH_ADDR, note: BOB_NOTE } });
    assert.equal(item.status, 201);
    const itemId = item.body.item.id as string;
    const bobSnapshot = (await call(base, "GET", `/cases/${caseId}`, { token: bob.token })).text;

    // A case id that never existed: every probe of Bob's id must answer exactly like this one.
    const FAKE_ID = "00000000-0000-4000-8000-000000000000";

    const alice = await signup(base, "alice@example.com");
    const mod = await signup(base, "mod@example.com");
    const admin = await signup(base, "admin@example.com");
    await stack.accounts.setRoleAsOperator("mod@example.com", "moderator");
    await stack.accounts.setRoleAsOperator("admin@example.com", "admin");

    for (const intruder of [alice, mod, admin]) {
      const responses: CallResult[] = [];
      const as = async (method: string, p: string, options: Parameters<typeof call>[3] = {}): Promise<CallResult> => {
        const res = await call(base, method, p, { token: intruder.token, ...options });
        responses.push(res);
        return res;
      };

      // 1. Every route against Bob's case id answers exactly like a nonexistent id: same status, same body.
      const probes: [string, string, unknown][] = [
        ["GET", "/cases/:id", undefined],
        ["PATCH", "/cases/:id", { title: "hijacked" }],
        ["DELETE", "/cases/:id", undefined],
        ["POST", "/cases/:id/close", undefined],
        ["POST", "/cases/:id/reopen", undefined],
        ["POST", "/cases/:id/items", { chain: "ethereum", address: ETH_ADDR_2, note: "planted" }],
        ["PATCH", `/cases/:id/items/${itemId}`, { note: "hijacked" }],
        ["DELETE", `/cases/:id/items/${itemId}`, undefined],
      ];
      for (const [method, template, body] of probes) {
        const real = await as(method, template.replace(":id", caseId), body === undefined ? {} : { body });
        const fake = await as(method, template.replace(":id", FAKE_ID), body === undefined ? {} : { body });
        assert.equal(real.status, 404, `${method} ${template} on Bob's case → ${real.status} ${real.text}`);
        assert.equal(real.text, fake.text, `${method} ${template}: Bob's case must be indistinguishable from no case`);
      }

      // 2. List: the intruder's own list is empty, however they try to name Bob as the owner.
      for (const q of ["", `?userId=${bob.id}`, `?ownedBy=${bob.id}`, `?owner=${bob.id}`, "?as=bob@example.com", "?status=open"]) {
        assert.deepEqual((await as("GET", `/cases${q}`)).body.cases, [], `list${q}`);
        assert.equal((await as("GET", `/cases/${caseId}${q}`)).status, 404);
      }
      const spoofHeaders = { "x-user-id": bob.id, "x-forwarded-user": bob.id, "x-owner": bob.id };
      assert.deepEqual((await as("GET", "/cases", { headers: spoofHeaders })).body.cases, []);
      assert.equal((await as("GET", `/cases/${caseId}`, { headers: spoofHeaders })).status, 404);

      // 3. Path tricks: Bob's id or email as a segment, traversal, encoded slashes, double slashes.
      for (const p of [
        `/cases/${bob.id}`,
        `/cases/${bob.id}/${caseId}`,
        `/cases/users/${bob.id}`,
        `/cases/bob%40example.com/${caseId}`,
        `/cases/${caseId}/..`,
        `/cases/x/..%2F${caseId}`,
        `/cases/x%2F..%2F${caseId}`,
        `/cases//${caseId}`,
        `/cases/%2e%2e/${caseId}`,
        `/cases/${caseId}/items`,
        `/cases/${caseId}/items/${itemId}`,
      ]) {
        const res = await as("GET", p);
        assert.ok(res.status >= 400 || (Array.isArray(res.body?.cases) && res.body.cases.length === 0), `${p} → ${res.status} ${res.text}`);
      }

      // 4. Creating a case "for" Bob: the owner fields in the body are ignored — it's the intruder's own.
      const own = await as("POST", "/cases", { body: { title: "intruder's own", ownedBy: bob.id, userId: bob.id, id: caseId } });
      assert.equal(own.status, 201);
      assert.notEqual(own.body.case.id, caseId, "a client-supplied id is never honoured");
      // ...and the intruder's own case can't be used as a doorway to Bob's item.
      const viaOwn = await as("PATCH", `/cases/${own.body.case.id}/items/${itemId}`, { body: { note: "hijacked" } });
      assert.equal(viaOwn.status, 404);
      assert.equal((await as("DELETE", `/cases/${own.body.case.id}/items/${itemId}`)).status, 404);
      assert.equal((await as("DELETE", `/cases/${own.body.case.id}`)).status, 204);

      // 5. Not one byte of Bob's title, description, note or account id appeared in any response.
      for (const res of responses) {
        for (const secret of [BOB_TITLE, BOB_DESC, BOB_NOTE, bob.id]) {
          assert.equal(res.text.includes(secret), false, `leak of ${secret.slice(0, 12)}… in ${res.status} ${res.text}`);
        }
      }
    }

    // 6. Bob's case is byte-for-byte what it was before any of that.
    assert.equal((await call(base, "GET", `/cases/${caseId}`, { token: bob.token })).text, bobSnapshot);

    // 7. On disk, Bob's case and item are stored under Bob's id only.
    const file = JSON.parse(await readFile(stack.casesPath, "utf8")) as { cases: { id: string; ownedBy: string }[]; items: { caseId: string; ownedBy: string }[] };
    assert.equal(file.cases.find((c) => c.id === caseId)?.ownedBy, bob.id);
    for (const i of file.items.filter((x) => x.caseId === caseId)) assert.equal(i.ownedBy, bob.id);
  });
});

test("ISOLATION: a logged-out, forged or expired session can't read or change any case", async () => {
  await withServer(async (base, stack) => {
    const bob = await signup(base, "bob@example.com");
    const created = await call(base, "POST", "/cases", { token: bob.token, body: { title: "bob secret case" } });
    const caseId = created.body.case.id as string;

    const second = await call(base, "POST", "/accounts/login", { body: { email: "bob@example.com", password: GOOD_PASSWORD } });
    const liveToken = second.body.session.token as string;
    assert.equal((await call(base, "POST", "/accounts/logout", { token: bob.token })).status, 204);

    for (const token of [bob.token, "ots_" + "A".repeat(43), "not-even-a-token"]) {
      for (const [method, p, body] of [
        ["GET", "/cases", undefined],
        ["POST", "/cases", { title: "planted" }],
        ["GET", `/cases/${caseId}`, undefined],
        ["PATCH", `/cases/${caseId}`, { title: "hijacked" }],
        ["DELETE", `/cases/${caseId}`, undefined],
        ["POST", `/cases/${caseId}/close`, undefined],
        ["POST", `/cases/${caseId}/items`, { chain: "ethereum", address: ETH_ADDR }],
      ] as const) {
        const res = await call(base, method, p, { token, body });
        assert.equal(res.status, 401, `${method} ${p} with ${token.slice(0, 8)}…`);
        assert.equal(res.text.includes("bob secret case"), false);
      }
    }
    // A token in the query string or a non-Bearer scheme is not accepted either.
    assert.equal((await call(base, "GET", `/cases?token=${liveToken}`)).status, 401);
    assert.equal((await call(base, "GET", "/cases", { headers: { authorization: `Basic ${liveToken}` } })).status, 401);

    // Nothing was changed by any of that.
    const now = await call(base, "GET", "/cases", { token: liveToken });
    assert.deepEqual(now.body.cases.map((c: { title: string; status: string }) => [c.title, c.status]), [["bob secret case", "open"]]);

    // Past the 30-day absolute expiry the session is rejected through the real accounts code path.
    stack.clock.advance(30 * 24 * 60 * 60 * 1000 + 1);
    assert.equal((await call(base, "GET", "/cases", { token: liveToken })).status, 401);
  });
});

test("ISOLATION under concurrency: many users building cases at once each see only their own", async () => {
  await withServer(async (base) => {
    const users = await Promise.all(Array.from({ length: 8 }, (_, i) => signup(base, `u${i}@example.com`)));
    const cases = await Promise.all(
      users.map((u, i) => call(base, "POST", "/cases", { token: u.token, body: { title: `case of user ${i}` } })),
    );
    await Promise.all(
      users.flatMap((u, i) => [
        call(base, "POST", `/cases/${cases[i]!.body.case.id}/items`, { token: u.token, body: { chain: "ethereum", address: ETH_ADDR, note: `note of user ${i}` } }),
        call(base, "POST", `/cases/${cases[i]!.body.case.id}/items`, { token: u.token, body: { chain: "solana", address: SOL_ADDR, note: `sol note of user ${i}` } }),
      ]),
    );
    for (const [i, u] of users.entries()) {
      const list = await call(base, "GET", "/cases", { token: u.token });
      assert.deepEqual(list.body.cases.map((c: { title: string; itemCount: number }) => [c.title, c.itemCount]), [[`case of user ${i}`, 2]]);
      const detail = await call(base, "GET", `/cases/${cases[i]!.body.case.id}`, { token: u.token });
      assert.deepEqual(detail.body.items.map((it: { note: string }) => it.note).sort(), [`note of user ${i}`, `sol note of user ${i}`]);
      for (let j = 0; j < users.length; j++) {
        if (j !== i) {
          assert.equal(list.text.includes(`user ${j}`), false);
          assert.equal(detail.text.includes(`user ${j}`), false);
        }
      }
    }
  });
});

test("status codes: 400 bad input/JSON/encoding, 404 unknown route, 405 wrong method, 409 limits, 413 oversized body", async () => {
  await withServer(
    async (base) => {
      const a = await signup(base, "a@example.com");
      const t = { token: a.token };
      assert.equal((await call(base, "POST", "/cases", { ...t, body: { title: "" } })).body.error, "invalid_case");
      assert.equal((await call(base, "POST", "/cases", { ...t, rawBody: "{ nope" })).body.error, "bad_request");
      assert.equal((await call(base, "POST", "/cases", { ...t, rawBody: "[1,2]" })).status, 400);
      assert.equal((await call(base, "GET", "/cases?status=archived", t)).body.error, "invalid_case");

      const created = await call(base, "POST", "/cases", { ...t, body: { title: "status codes" } });
      const id = created.body.case.id as string;
      const items = `/cases/${id}/items`;
      assert.equal((await call(base, "POST", items, { ...t, body: { chain: "bitcoin", address: ETH_ADDR } })).body.error, "invalid_chain");
      const badAddress = await call(base, "POST", items, { ...t, body: { chain: "ethereum", address: "0xdeadbeef-not-real" } });
      assert.equal(badAddress.body.error, "invalid_address");
      assert.equal(badAddress.text.includes("0xdeadbeef-not-real"), false, "input is never echoed back");
      assert.equal((await call(base, "PATCH", `/cases/${id}`, { ...t, body: {} })).body.error, "invalid_case");
      assert.equal((await call(base, "POST", "/cases", { ...t, body: { title: "x", description: "x".repeat(70_000) } })).status, 413);
      assert.equal((await call(base, "GET", "/cases/%E0%A4%A", t)).status, 400);

      const unknown = await call(base, "GET", `/cases/${id}/whatever/deeper/path-secret`, t);
      assert.equal(unknown.status, 404);
      assert.equal(unknown.text.includes("path-secret"), false, "the request path is never echoed back");

      assert.equal((await call(base, "PUT", "/cases", t)).status, 405);
      assert.equal((await call(base, "PUT", `/cases/${id}`, t)).status, 405);
      assert.equal((await call(base, "GET", `/cases/${id}/close`, t)).status, 405);
      assert.equal((await call(base, "GET", items, t)).status, 405);

      assert.equal((await call(base, "POST", items, { ...t, body: { chain: "ethereum", address: ETH_ADDR } })).status, 201);
      const overItems = await call(base, "POST", items, { ...t, body: { chain: "ethereum", address: ETH_ADDR_2 } });
      assert.equal(overItems.status, 409);
      assert.equal(overItems.body.error, "limit_reached");
      const overCases = await call(base, "POST", "/cases", { ...t, body: { title: "second" } });
      assert.equal(overCases.status, 409);
      assert.equal(overCases.body.error, "limit_reached");
    },
    { casesPerUserLimit: 1, itemsPerCaseLimit: 1 },
  );
});

test("responses are never cacheable and vary on Authorization; CORS allows only the configured origin", async () => {
  await withServer(async (base) => {
    const a = await signup(base, "a@example.com");
    const res = await call(base, "GET", "/cases", { token: a.token, origin: WEB_ORIGIN });
    assert.match(res.headers.get("cache-control") ?? "", /no-store/);
    assert.match(res.headers.get("cache-control") ?? "", /private/);
    assert.match(res.headers.get("vary") ?? "", /Authorization/);
    assert.equal(res.headers.get("access-control-allow-origin"), WEB_ORIGIN);

    const preflight = await call(base, "OPTIONS", "/cases/some-id/items/some-item", { origin: WEB_ORIGIN });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /PATCH/);
    assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /DELETE/);
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /authorization/);

    const evil = await call(base, "GET", "/cases", { token: a.token, origin: "https://evil.example" });
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
  });
});

test("paths outside /cases are left for the host server", async () => {
  await withServer(async (base) => {
    assert.equal((await call(base, "GET", "/casesx")).status, 404);
    assert.equal((await call(base, "GET", "/bounties")).status, 404);
  });
});
