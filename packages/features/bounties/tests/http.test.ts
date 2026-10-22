import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAccountsHandler } from "@osstrace/accounts";
import { createBountiesHandler } from "../src/http.ts";
import { GOOD_PASSWORD, validBountyBody, validSubmissionBody, withEnv, type Env } from "./helpers.ts";

const WEB_ORIGIN = "http://localhost:5301";

/** A real HTTP server on an ephemeral port with both the accounts routes and the bounty routes mounted. */
async function withServer(run: (base: string, env: Env) => Promise<void>): Promise<void> {
  await withEnv(async (env) => {
    const accountsHandler = createAccountsHandler(env.accounts, { allowedOrigins: [WEB_ORIGIN] });
    const bountiesHandler = createBountiesHandler(env.service, { allowedOrigins: [WEB_ORIGIN] });
    const server: Server = createServer(async (req, res) => {
      if (await accountsHandler(req, res)) return;
      if (await bountiesHandler(req, res)) return;
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
  options: { body?: unknown; token?: string; origin?: string } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers["authorization"] = `Bearer ${options.token}`;
  if (options.origin) headers["origin"] = options.origin;
  const res = await fetch(base + path, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

async function signup(base: string, email: string): Promise<{ id: string; token: string }> {
  const res = await call(base, "POST", "/accounts/signup", { body: { email, password: GOOD_PASSWORD } });
  assert.equal(res.status, 201);
  return { id: res.body.user.id, token: res.body.session.token };
}

test("full flow over real HTTP: open -> public list -> submit -> moderator claims -> publicly visible claimed bounty", async () => {
  await withServer(async (base, env) => {
    const poster = await signup(base, "poster@example.com");
    const opened = await call(base, "POST", "/bounties", { token: poster.token, body: validBountyBody() });
    assert.equal(opened.status, 201);
    assert.equal(opened.body.bounty.status, "open");
    const bountyId = opened.body.bounty.id as string;

    // Public: no token needed to browse the board.
    const publicList = await call(base, "GET", "/bounties");
    assert.equal(publicList.status, 200);
    assert.equal(publicList.body.bounties.length, 1);
    assert.equal(publicList.headers.get("cache-control"), "no-store");

    const dev = await signup(base, "dev@example.com");
    const noAuth = await call(base, "POST", `/bounties/${bountyId}/submissions`, { body: validSubmissionBody() });
    assert.equal(noAuth.status, 401);

    const submitted = await call(base, "POST", `/bounties/${bountyId}/submissions`, { token: dev.token, body: validSubmissionBody() });
    assert.equal(submitted.status, 201);
    assert.equal(submitted.body.submission.outcome, "pending");
    const submissionId = submitted.body.submission.id as string;

    const publicSubmissions = await call(base, "GET", `/bounties/${bountyId}/submissions`);
    assert.equal(publicSubmissions.status, 200);
    assert.equal(publicSubmissions.body.submissions.length, 1);

    // A plain logged-in user can't claim.
    const forbiddenClaim = await call(base, "POST", `/bounties/${bountyId}/claim`, { token: dev.token, body: { submissionId } });
    assert.equal(forbiddenClaim.status, 403);

    await env.accounts.setRoleAsOperator("poster@example.com", "moderator");
    const claimed = await call(base, "POST", `/bounties/${bountyId}/claim`, { token: poster.token, body: { submissionId } });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.bounty.status, "claimed");
    assert.equal(claimed.body.bounty.claimedBy, dev.id);

    const detail = await call(base, "GET", `/bounties/${bountyId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.bounty.status, "claimed");
  });
});

test("status codes: 400 invalid body, 404 unknown bounty, CORS headers only for the allowed origin", async () => {
  await withServer(async (base) => {
    const poster = await signup(base, "poster2@example.com");
    const badBody = await call(base, "POST", "/bounties", { token: poster.token, body: { title: "" } });
    assert.equal(badBody.status, 400);

    const missing = await call(base, "GET", "/bounties/does-not-exist");
    assert.equal(missing.status, 404);

    const allowed = await call(base, "GET", "/bounties", { origin: WEB_ORIGIN });
    assert.equal(allowed.headers.get("access-control-allow-origin"), WEB_ORIGIN);
    const disallowed = await call(base, "GET", "/bounties", { origin: "http://evil.example.com" });
    assert.equal(disallowed.headers.get("access-control-allow-origin"), null);
  });
});

test("a malformed %-escape in a bounty id gets a clean 400, not a generic 500, and the server keeps serving", async () => {
  await withServer(async (base) => {
    // decodeURIComponent('%E0%A4%A') throws a real URIError. The outer try/catch here already
    // kept that from crashing the process, but it used to fall through to a generic 500
    // "internal error" instead of a specific 400 — checked against every route that decodes an
    // id from the path.
    for (const [method, path] of [
      ["GET", "/bounties/%E0%A4%A"],
      ["GET", "/bounties/%E0%A4%A/submissions"],
      ["POST", "/bounties/%E0%A4%A/submissions"],
      ["POST", "/bounties/%E0%A4%A/claim"],
      ["POST", "/bounties/%E0%A4%A/cancel"],
    ] as const) {
      const res = await call(base, method, path, method === "POST" ? { body: {} } : {});
      assert.equal(res.status, 400, `${method} ${path}`);
      assert.equal(res.body.error, "invalid_bounty", `${method} ${path}`);
    }

    const stillUp = await call(base, "GET", "/bounties");
    assert.equal(stillUp.status, 200, "the server must still be up after every malformed id");
  });
});
