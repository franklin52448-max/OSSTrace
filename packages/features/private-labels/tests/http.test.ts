import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { call, ETH_ADDR, ETH_ADDR_2, signup, SOL_ADDR, WEB_ORIGIN, withServer, type CallResult } from "./helpers.ts";

const path = (chain: string, address: string): string => `/private-labels/${chain}/${encodeURIComponent(address)}`;

test("full flow over real HTTP: 401 without a session, then PUT 201 → GET → PUT 200 → list → DELETE 204 → DELETE 404", async () => {
  await withServer(async (base) => {
    assert.equal((await call(base, "GET", "/private-labels")).status, 401);
    assert.equal((await call(base, "GET", path("ethereum", ETH_ADDR))).status, 401);

    const a = await signup(base, "a@example.com");
    const none = await call(base, "GET", path("ethereum", ETH_ADDR), { token: a.token });
    assert.equal(none.status, 200);
    assert.equal(none.body.label, null);

    const created = await call(base, "PUT", path("ethereum", ETH_ADDR), { token: a.token, body: { label: "my cold wallet" } });
    assert.equal(created.status, 201);
    assert.equal(created.body.created, true);
    assert.equal(created.body.label.label, "my cold wallet");

    const updated = await call(base, "PUT", path("ethereum", ETH_ADDR), { token: a.token, body: { label: "renamed" } });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.created, false);

    const list = await call(base, "GET", "/private-labels", { token: a.token });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.labels.map((l: { label: string }) => l.label), ["renamed"]);

    assert.equal((await call(base, "DELETE", path("ethereum", ETH_ADDR), { token: a.token })).status, 204);
    const again = await call(base, "DELETE", path("ethereum", ETH_ADDR), { token: a.token });
    assert.equal(again.status, 404);
    assert.equal(again.body.error, "not_found");
  });
});

/**
 * The property this whole package exists to guarantee. Bob saves secrets; Alice — a real,
 * fully-authenticated user — tries every route and every trick we could think of to read,
 * overwrite or delete them. None may work, and none of Bob's text may appear in any byte of any
 * response Alice gets.
 */
test("ISOLATION: user A cannot read, list, overwrite or delete user B's private labels, by any route or trick", async () => {
  await withServer(async (base, stack) => {
    const bob = await signup(base, "bob@example.com");
    const alice = await signup(base, "alice@example.com");
    const BOB_SECRET = "bob-secret-cold-wallet-7f3a";
    const BOB_SECRET_SOL = "bob-secret-solana-informant-91c2";

    assert.equal((await call(base, "PUT", path("ethereum", ETH_ADDR), { token: bob.token, body: { label: BOB_SECRET } })).status, 201);
    assert.equal((await call(base, "PUT", path("solana", SOL_ADDR), { token: bob.token, body: { label: BOB_SECRET_SOL } })).status, 201);

    const aliceResponses: CallResult[] = [];
    const asAlice = async (method: string, p: string, options: Parameters<typeof call>[3] = {}): Promise<CallResult> => {
      const res = await call(base, method, p, { token: alice.token, ...options });
      aliceResponses.push(res);
      return res;
    };

    // 1. Read Bob's addresses directly — Alice sees "no label", not Bob's.
    assert.equal((await asAlice("GET", path("ethereum", ETH_ADDR))).body.label, null);
    assert.equal((await asAlice("GET", path("solana", SOL_ADDR))).body.label, null);
    // ...including every other spelling of the same Ethereum address.
    assert.equal((await asAlice("GET", path("ethereum", ETH_ADDR.toUpperCase().replace("0X", "0x")))).body.label, null);
    assert.equal((await asAlice("GET", path("ethereum", ` ${ETH_ADDR} `))).body.label, null);

    // 2. List — Alice's list is empty.
    assert.deepEqual((await asAlice("GET", "/private-labels")).body.labels, []);
    assert.deepEqual((await asAlice("GET", "/private-labels/")).body.labels, []);

    // 3. Try to name Bob as the owner: query string, custom headers, body fields. All ignored.
    for (const q of [`?userId=${bob.id}`, `?user=${bob.id}`, `?owner=${bob.id}`, `?as=bob@example.com`]) {
      assert.deepEqual((await asAlice("GET", `/private-labels${q}`)).body.labels, []);
      assert.equal((await asAlice("GET", path("ethereum", ETH_ADDR) + q)).body.label, null);
    }
    const spoofHeaders = { "x-user-id": bob.id, "x-forwarded-user": bob.id, "x-owner": bob.id };
    assert.deepEqual((await asAlice("GET", "/private-labels", { headers: spoofHeaders })).body.labels, []);

    // 4. Path tricks: Bob's id or email as a path segment, traversal, double slashes.
    for (const p of [
      `/private-labels/${bob.id}`,
      `/private-labels/${bob.id}/ethereum/${ETH_ADDR}`,
      `/private-labels/users/${bob.id}`,
      `/private-labels/bob%40example.com/ethereum/${ETH_ADDR}`,
      `/private-labels/ethereum/${ETH_ADDR}/..`,
      `/private-labels/ethereum/${ETH_ADDR}%2F..%2F${bob.id}`,
      `/private-labels//ethereum/${ETH_ADDR}`,
      `/private-labels/%2e%2e/${bob.id}`,
    ]) {
      const res = await asAlice("GET", p);
      assert.ok(res.status >= 400 || res.body?.label === null || Array.isArray(res.body?.labels) && res.body.labels.length === 0, `${p} → ${res.status} ${res.text}`);
    }

    // 5. Overwrite attempt: Alice PUTs the same address, even claiming Bob's id in the body.
    const put = await asAlice("PUT", path("ethereum", ETH_ADDR), { body: { label: "alice's own note", userId: bob.id, owner: bob.id } });
    assert.equal(put.status, 201, "Alice creates her OWN label — it isn't an update of Bob's");
    assert.equal(put.body.created, true);
    const bobStill = await call(base, "GET", path("ethereum", ETH_ADDR), { token: bob.token });
    assert.equal(bobStill.body.label.label, BOB_SECRET);

    // 6. Delete attempts: Alice deletes the shared address (removes only hers), then Bob's Solana one (404).
    assert.equal((await asAlice("DELETE", path("ethereum", ETH_ADDR))).status, 204);
    assert.equal((await asAlice("DELETE", path("ethereum", ETH_ADDR))).status, 404);
    assert.equal((await asAlice("DELETE", path("solana", SOL_ADDR))).status, 404);
    assert.equal((await asAlice("DELETE", path("solana", SOL_ADDR), { body: { userId: bob.id } })).status, 404);

    // 7. Bob's labels are exactly as he left them.
    const bobList = await call(base, "GET", "/private-labels", { token: bob.token });
    assert.deepEqual(bobList.body.labels.map((l: { label: string }) => l.label).sort(), [BOB_SECRET, BOB_SECRET_SOL].sort());

    // 8. Not one byte of any of Bob's secrets, or his account id, appeared in any response to Alice.
    for (const res of aliceResponses) {
      assert.equal(res.text.includes(BOB_SECRET), false, `leak in ${res.status} ${res.text}`);
      assert.equal(res.text.includes(BOB_SECRET_SOL), false, `leak in ${res.status} ${res.text}`);
      assert.equal(res.text.includes(bob.id), false, `owner id leak in ${res.status} ${res.text}`);
    }
    // And no response carries an owner id at all — Bob's own responses don't include his id either.
    assert.equal(bobList.text.includes(bob.id), false);

    // 9. On disk, Bob's secrets are stored under Bob's id only.
    const file = JSON.parse(await readFile(stack.labelsPath, "utf8")) as { labels: { userId: string; label: string }[] };
    for (const entry of file.labels.filter((l) => l.label.startsWith("bob-secret"))) assert.equal(entry.userId, bob.id);
  });
});

test("ISOLATION: a logged-out, forged or expired session can't read or change anyone's labels", async () => {
  await withServer(async (base, stack) => {
    const bob = await signup(base, "bob@example.com");
    await call(base, "PUT", path("ethereum", ETH_ADDR), { token: bob.token, body: { label: "bob secret" } });

    // Bob's token after Bob logs out is dead — including for Bob's own data.
    const second = await call(base, "POST", "/accounts/login", { body: { email: "bob@example.com", password: "correct horse battery staple" } });
    const liveToken = second.body.session.token as string;
    assert.equal((await call(base, "POST", "/accounts/logout", { token: bob.token })).status, 204);
    for (const token of [bob.token, "ots_" + "A".repeat(43), "not-even-a-token"]) {
      for (const [method, p, body] of [
        ["GET", "/private-labels", undefined],
        ["GET", path("ethereum", ETH_ADDR), undefined],
        ["PUT", path("ethereum", ETH_ADDR), { label: "hijacked" }],
        ["DELETE", path("ethereum", ETH_ADDR), undefined],
      ] as const) {
        const res = await call(base, method, p, { token, body });
        assert.equal(res.status, 401, `${method} ${p} with ${token.slice(0, 8)}…`);
        assert.equal(res.text.includes("bob secret"), false);
      }
    }
    // Basic-auth style or a token in the query string is not accepted either.
    assert.equal((await call(base, "GET", `/private-labels?token=${liveToken}`)).status, 401);
    assert.equal((await call(base, "GET", "/private-labels", { headers: { authorization: `Basic ${liveToken}` } })).status, 401);

    // Nothing was changed by any of that.
    const bobNow = await call(base, "GET", path("ethereum", ETH_ADDR), { token: liveToken });
    assert.equal(bobNow.body.label.label, "bob secret");

    // Past the 30-day absolute expiry the session is rejected through the real accounts code path.
    stack.clock.advance(30 * 24 * 60 * 60 * 1000 + 1);
    assert.equal((await call(base, "GET", "/private-labels", { token: liveToken })).status, 401);
  });
});

test("ISOLATION under concurrency: many users writing the same address at once each read back only their own", async () => {
  await withServer(async (base) => {
    const users = await Promise.all(Array.from({ length: 8 }, (_, i) => signup(base, `u${i}@example.com`)));
    await Promise.all(
      users.flatMap((u, i) => [
        call(base, "PUT", path("ethereum", ETH_ADDR), { token: u.token, body: { label: `shared-addr note of user ${i}` } }),
        call(base, "PUT", path("ethereum", ETH_ADDR_2), { token: u.token, body: { label: `second note of user ${i}` } }),
      ]),
    );
    for (const [i, u] of users.entries()) {
      const got = await call(base, "GET", path("ethereum", ETH_ADDR), { token: u.token });
      assert.equal(got.body.label.label, `shared-addr note of user ${i}`);
      const list = await call(base, "GET", "/private-labels", { token: u.token });
      assert.deepEqual(list.body.labels.map((l: { label: string }) => l.label).sort(), [`second note of user ${i}`, `shared-addr note of user ${i}`]);
      for (let j = 0; j < users.length; j++) {
        if (j !== i) assert.equal(list.text.includes(`user ${j}`), false);
      }
    }
  });
});

test("status codes: 400 bad chain/address/label/JSON, 413 oversized body, 405 wrong method, 409 limit", async () => {
  await withServer(
    async (base) => {
      const a = await signup(base, "a@example.com");
      const t = { token: a.token };
      assert.equal((await call(base, "GET", path("bitcoin", ETH_ADDR), t)).body.error, "invalid_chain");
      assert.equal((await call(base, "GET", path("ethereum", "0x12"), t)).body.error, "invalid_address");
      assert.equal((await call(base, "PUT", path("ethereum", ETH_ADDR), { ...t, body: { label: "" } })).body.error, "invalid_label");
      assert.equal((await call(base, "PUT", path("ethereum", ETH_ADDR), { ...t, body: {} })).status, 400);
      assert.equal((await call(base, "PUT", path("ethereum", ETH_ADDR), { ...t, rawBody: "{ nope" })).body.error, "bad_request");
      assert.equal((await call(base, "PUT", path("ethereum", ETH_ADDR), { ...t, body: { label: "x".repeat(10_000) } })).status, 413);
      assert.equal((await call(base, "GET", "/private-labels/ethereum/%E0%A4%A", t)).status, 400);
      assert.equal((await call(base, "POST", "/private-labels", t)).status, 405);
      assert.equal((await call(base, "POST", path("ethereum", ETH_ADDR), t)).status, 405);

      assert.equal((await call(base, "PUT", path("ethereum", ETH_ADDR), { ...t, body: { label: "one" } })).status, 201);
      const over = await call(base, "PUT", path("solana", SOL_ADDR), { ...t, body: { label: "two" } });
      assert.equal(over.status, 409);
      assert.equal(over.body.error, "limit_reached");
    },
    { perUserLimit: 1 },
  );
});

test("responses are never cacheable and vary on Authorization; CORS allows only the configured origin", async () => {
  await withServer(async (base) => {
    const a = await signup(base, "a@example.com");
    const res = await call(base, "GET", "/private-labels", { token: a.token, origin: WEB_ORIGIN });
    assert.match(res.headers.get("cache-control") ?? "", /no-store/);
    assert.match(res.headers.get("vary") ?? "", /Authorization/);
    assert.equal(res.headers.get("access-control-allow-origin"), WEB_ORIGIN);

    const preflight = await call(base, "OPTIONS", path("ethereum", ETH_ADDR), { origin: WEB_ORIGIN });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /DELETE/);
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /authorization/);

    const evil = await call(base, "GET", "/private-labels", { token: a.token, origin: "https://evil.example" });
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
  });
});

test("paths outside /private-labels are left for the host server", async () => {
  await withServer(async (base) => {
    assert.equal((await call(base, "GET", "/address/ethereum/0xabc")).status, 404);
    assert.equal((await call(base, "GET", "/private-labelsx")).status, 404);
  });
});
