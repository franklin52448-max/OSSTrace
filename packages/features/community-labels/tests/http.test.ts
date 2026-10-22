import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAccountsHandler } from "@osstrace/accounts";
import { createLabelSubmissionsHandler } from "../src/http.ts";
import { CommunityLabelReader } from "../src/reader.ts";
import { JsonFileSubmissionStore } from "../src/store.ts";
import { readFile } from "node:fs/promises";
import { ETH_ADDRESS, GOOD_PASSWORD, SOL_ADDRESS, validBody, withEnv, type Env } from "./helpers.ts";

const WEB_ORIGIN = "http://localhost:5301";

/**
 * A real HTTP server on an ephemeral port with both the accounts routes and the submission routes
 * mounted — the same way a deployment could host them together — over real temp-file stores.
 */
async function withServer(run: (base: string, env: Env) => Promise<void>): Promise<void> {
  await withEnv(async (env) => {
    const accountsHandler = createAccountsHandler(env.accounts, { allowedOrigins: [WEB_ORIGIN] });
    const labelsHandler = createLabelSubmissionsHandler(env.service, { allowedOrigins: [WEB_ORIGIN] });
    const server: Server = createServer(async (req, res) => {
      if (await accountsHandler(req, res)) return;
      if (await labelsHandler(req, res)) return;
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${port}`, env);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

async function call(
  base: string,
  method: string,
  path: string,
  options: { body?: unknown; rawBody?: string; token?: string; origin?: string } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined || options.rawBody !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers["authorization"] = `Bearer ${options.token}`;
  if (options.origin) headers["origin"] = options.origin;
  const res = await fetch(base + path, {
    method,
    headers,
    body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

async function signup(base: string, email: string): Promise<{ id: string; token: string }> {
  const res = await call(base, "POST", "/accounts/signup", { body: { email, password: GOOD_PASSWORD } });
  assert.equal(res.status, 201);
  return { id: res.body.user.id, token: res.body.session.token };
}

test("full flow over real HTTP: signup → submit → public community label → moderator confirms → confirmed label", async () => {
  await withServer(async (base, env) => {
    const alice = await signup(base, "alice@example.com");
    const submitted = await call(base, "POST", "/labels/submissions", { token: alice.token, body: validBody() });
    assert.equal(submitted.status, 201);
    assert.equal(submitted.body.submission.status, "community");
    assert.equal(submitted.body.submission.submittedBy, alice.id);
    assert.equal(submitted.headers.get("cache-control"), "no-store");
    const id = submitted.body.submission.id as string;

    // What the Explorer would show, read through a separate store instance on the same file.
    const reader = new CommunityLabelReader(new JsonFileSubmissionStore(env.submissionsPath));
    const address = { chain: "ethereum" as const, value: ETH_ADDRESS.toLowerCase() };
    assert.equal((await reader.getLabel(address))?.reviewStatus, "community");

    const mod = await signup(base, "mod@example.com");
    assert.ok((await env.accounts.setRoleAsOperator("mod@example.com", "moderator")).ok);

    const queue = await call(base, "GET", "/labels/submissions", { token: mod.token });
    assert.equal(queue.status, 200);
    assert.deepEqual(queue.body.submissions.map((s: { id: string }) => s.id), [id]);

    const confirmed = await call(base, "POST", `/labels/submissions/${id}/confirm`, { token: mod.token });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.submission.status, "confirmed");
    assert.equal(confirmed.body.submission.reviewedBy, mod.id);

    const label = await reader.getLabel(address);
    assert.ok(label?.reviewStatus === "confirmed");
    assert.equal(label.confirmedBy, mod.id);

    const mine = await call(base, "GET", "/labels/submissions/mine", { token: alice.token });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.submissions[0].status, "confirmed");
  });
});

test("HTTP status codes: 401 no session, 403 not a moderator / own submission, 400 no source, 404, 409", async () => {
  await withServer(async (base, env) => {
    assert.equal((await call(base, "POST", "/labels/submissions", { body: validBody() })).status, 401);
    const alice = await signup(base, "alice@example.com");

    const noSource = await call(base, "POST", "/labels/submissions", { token: alice.token, body: validBody({ source: undefined }) });
    assert.equal(noSource.status, 400);
    assert.equal(noSource.body.error, "invalid_submission");
    assert.match(noSource.body.message, /source/);

    const ok = await call(base, "POST", "/labels/submissions", { token: alice.token, body: validBody() });
    assert.equal(ok.status, 201);
    const dup = await call(base, "POST", "/labels/submissions", { token: alice.token, body: validBody() });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, "duplicate_submission");

    assert.equal((await call(base, "GET", "/labels/submissions", { token: alice.token })).status, 403);
    assert.equal((await call(base, "POST", `/labels/submissions/${ok.body.submission.id}/confirm`, { token: alice.token })).status, 403);

    const mod = await signup(base, "mod@example.com");
    assert.ok((await env.accounts.setRoleAsOperator("mod@example.com", "moderator")).ok);
    const own = await call(base, "POST", "/labels/submissions", { token: mod.token, body: validBody() });
    const ownConfirm = await call(base, "POST", `/labels/submissions/${own.body.submission.id}/confirm`, { token: mod.token });
    assert.equal(ownConfirm.status, 403);
    assert.equal(ownConfirm.body.error, "own_submission");

    assert.equal((await call(base, "POST", "/labels/submissions/nope/confirm", { token: mod.token })).status, 404);
    const noReason = await call(base, "POST", `/labels/submissions/${ok.body.submission.id}/reject`, { token: mod.token, body: {} });
    assert.equal(noReason.status, 400);
    const rejected = await call(base, "POST", `/labels/submissions/${ok.body.submission.id}/reject`, {
      token: mod.token,
      body: { reason: "the cited page doesn't mention this address" },
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.submission.status, "rejected");
    const again = await call(base, "POST", `/labels/submissions/${ok.body.submission.id}/confirm`, { token: mod.token });
    assert.equal(again.status, 409);

    assert.equal((await call(base, "GET", "/labels/submissions?status=bogus", { token: mod.token })).status, 400);
    const rejectedList = await call(base, "GET", "/labels/submissions?status=rejected", { token: mod.token });
    assert.equal(rejectedList.body.submissions.length, 1);
  });
});

test("share as Community label over real HTTP: draft → 400 without a source → 201 with one", async () => {
  await withServer(async (base, env) => {
    const alice = await signup(base, "alice@example.com");
    assert.ok((await env.privateLabels.set(alice.token, "ethereum", ETH_ADDRESS, "my Safe singleton note")).ok);
    const privateBefore = await readFile(env.privateLabelsPath, "utf8");

    const draft = await call(base, "GET", `/labels/submissions/from-private-label/ethereum/${ETH_ADDRESS}`, { token: alice.token });
    assert.equal(draft.status, 200);
    assert.equal(draft.body.draft.name, "my Safe singleton note");
    assert.equal(draft.body.draft.source, null);

    const { source, ...noSource } = validBody({ name: draft.body.draft.name });
    const refused = await call(base, "POST", "/labels/submissions/from-private-label", { token: alice.token, body: noSource });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, "invalid_submission");
    assert.match(refused.body.message, /source/);

    const shared = await call(base, "POST", "/labels/submissions/from-private-label", {
      token: alice.token,
      body: { ...noSource, source },
    });
    assert.equal(shared.status, 201);
    assert.equal(shared.body.submission.status, "community");
    assert.equal(shared.body.submission.name, "my Safe singleton note");
    assert.equal(await readFile(env.privateLabelsPath, "utf8"), privateBefore);

    const none = await call(base, "GET", `/labels/submissions/from-private-label/solana/${SOL_ADDRESS}`, { token: alice.token });
    assert.equal(none.status, 404);
    assert.equal((await call(base, "GET", `/labels/submissions/from-private-label/ethereum/${ETH_ADDRESS}`)).status, 401);
  });
});

test("over the submission rate limit is a real 429 with Retry-After, readable from the web origin", async () => {
  await withServer(async (base) => {
    const alice = await signup(base, "alice@example.com");
    for (let i = 0; i < 10; i++) {
      const address = `0x${(i + 1).toString(16).padStart(40, "0")}`;
      assert.equal((await call(base, "POST", "/labels/submissions", { token: alice.token, body: validBody({ address }) })).status, 201);
    }
    const limited = await call(base, "POST", "/labels/submissions", {
      token: alice.token,
      origin: WEB_ORIGIN,
      body: validBody({ address: `0x${"f".repeat(40)}` }),
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, "rate_limited");
    assert.equal(limited.body.retryAfterSeconds, 3600);
    assert.equal(limited.headers.get("retry-after"), "3600");
    assert.match(limited.headers.get("access-control-expose-headers") ?? "", /retry-after/);
  });
});

test("malformed and oversized bodies are 400/413, never a crash", async () => {
  await withServer(async (base) => {
    const alice = await signup(base, "alice@example.com");
    const bad = await call(base, "POST", "/labels/submissions", { token: alice.token, rawBody: "{not json" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "bad_request");
    const arr = await call(base, "POST", "/labels/submissions", { token: alice.token, rawBody: "[]" });
    assert.equal(arr.status, 400);
    const big = await call(base, "POST", "/labels/submissions", { token: alice.token, rawBody: JSON.stringify({ name: "x".repeat(20_000) }) });
    assert.equal(big.status, 413);
  });
});

test("a malformed %-escape in a submission id is a 400 bad request, not a 500 internal error", async () => {
  await withServer(async (base, env) => {
    const mod = await signup(base, "mod@example.com");
    assert.ok((await env.accounts.setRoleAsOperator("mod@example.com", "moderator")).ok);
    // Before: decodeURIComponent's URIError fell through to the catch-all and came back as
    // 500 "internal error", the client's mistake reported as a server fault.
    const res = await call(base, "POST", "/labels/submissions/%E0%A4%A/confirm", { token: mod.token });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "bad_request");
  });
});

test("CORS: only allowlisted origins get CORS headers; preflight works for them", async () => {
  await withServer(async (base) => {
    const preflight = await call(base, "OPTIONS", "/labels/submissions", { origin: WEB_ORIGIN });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), WEB_ORIGIN);
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /authorization/);

    const evil = await call(base, "OPTIONS", "/labels/submissions", { origin: "https://evil.example" });
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
  });
});
