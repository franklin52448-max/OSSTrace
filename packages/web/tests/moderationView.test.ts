import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement, type ComponentType } from "react";
import { cleanup, click, consoleErrors, during, getButton, getByAriaLabel, render, text, type, waitFor } from "./harness/render.ts";
import { FixedBalanceAdapter, startStack, type Stack } from "./harness/servers.ts";

// The moderator review queue against the real accounts + community-labels APIs: real
// submissions made over HTTP by a real account, reviewed by a real moderator account through the
// UI, with the result read back from the server.

const PASSWORD = "correct horse battery staple";
const SUBMITTER = "submitter@example.com";
const MODERATOR = "moderator@example.com";
const PLAIN = "plain@example.com";
const TO_CONFIRM = { address: "0x41675c099f32341bf84bfc5382af534df5c7461a", name: "Safe: Singleton 1.4.1" };
const TO_REJECT = { address: "0x252a8bd2319d8a555b872990601221b3a2053bce", name: "Definitely the treasury" };
const OWN = { address: "0x00000000219ab540356cbb839cbe05303d7705fa", name: "Beacon deposit contract" };
// "1 pending community submission", not "...submissions" (the heading runs straight into the Refresh button's text).
const ONE_PENDING = /\b1 pending community submission(?!s)/;

let stack: Stack;
let ModerationView: ComponentType;
let session: typeof import("../src/session.ts");
const tokens = new Map<string, string>();

interface Submission {
  id: string;
  name: string;
  status: string;
}

async function api<T>(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${stack.accounts.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as T };
}

/** A real Community submission, POSTed to the real API exactly as LabelSubmitForm does. */
async function submit(email: string, label: { address: string; name: string }): Promise<void> {
  const res = await api("POST", "/labels/submissions", tokens.get(email) as string, {
    chain: "ethereum",
    address: label.address,
    name: label.name,
    confidence: "verified",
    source: { url: "https://github.com/safe-global/safe-deployments", description: "the project's own deployments list" },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
}

async function signInAs(email: string): Promise<void> {
  await during(session.signOut());
  assert.equal(await during(session.signIn("login", email, PASSWORD)), null);
}

before(async () => {
  stack = await startStack(new FixedBalanceAdapter("ethereum", {}));
  for (const email of [SUBMITTER, MODERATOR, PLAIN]) {
    const signup = await stack.accountService.signup(email, PASSWORD);
    assert.ok(signup.ok);
    tokens.set(email, signup.session.token);
  }
  assert.ok((await stack.accountService.setRoleAsOperator(MODERATOR, "moderator")).ok);
  await submit(SUBMITTER, TO_CONFIRM);
  await submit(SUBMITTER, TO_REJECT);
  await submit(MODERATOR, OWN);
  session = await import("../src/session.ts");
  ({ default: ModerationView } = await import("../src/ModerationView.tsx"));
});

after(async () => {
  await stack.close();
});

beforeEach(() => {
  consoleErrors.length = 0;
});
afterEach(cleanup);

/** The card for one submission, by its heading. */
function card(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>("article[data-submission-id]")].find((a) => a.querySelector("h2")?.textContent === name);
  assert.ok(found, `no card for "${name}"`);
  return found;
}

test("signed out: refused, and told to log in with a moderator account", async () => {
  await render(createElement(ModerationView));
  await waitFor(() => text().includes("The review queue is for moderators."), "the refusal");
  assert.ok(text().includes("Log in with a moderator account."));
  assert.ok(!text().includes(TO_CONFIRM.name));
  assert.deepEqual(consoleErrors, []);
});

test("a plain user is refused by the UI, and the server refuses that account the queue too", async () => {
  await signInAs(PLAIN);
  await render(createElement(ModerationView));
  await waitFor(() => text().includes("Your account doesn't have the moderator role."), "the refusal");
  assert.ok(!text().includes(TO_CONFIRM.name));

  // The UI's refusal isn't the only gate: the same queue request, made with this account's token,
  // is a 403 from the real community-labels API.
  const direct = await api<{ error: string }>("GET", "/labels/submissions?status=community", tokens.get(PLAIN) as string);
  assert.equal(direct.status, 403);
  assert.equal(direct.body.error, "forbidden");
  assert.deepEqual(consoleErrors, []);
});

test("a moderator sees the real pending queue, confirms one, rejects one with a reason", async () => {
  await signInAs(MODERATOR);
  await render(createElement(ModerationView));
  await waitFor(() => text().includes("3 pending community submissions"), "the real queue");
  for (const { name } of [TO_CONFIRM, TO_REJECT, OWN]) assert.ok(text().includes(name), name);

  // Their own submission can't be reviewed by them: no buttons, just the explanation.
  const own = card(OWN.name);
  assert.ok(text(own).includes("(you)"));
  assert.ok(text(own).includes("Your own submission: another moderator has to review it."));
  assert.throws(() => getButton("Confirm", own));

  await click(getButton("Confirm", card(TO_CONFIRM.name)));
  await waitFor(() => text().includes(`Confirmed “${TO_CONFIRM.name}”.`), "the confirm notice");
  await waitFor(() => text().includes("2 pending community submissions"), "the confirmed one to leave the queue");

  const rejecting = card(TO_REJECT.name);
  await click(getButton("Reject…", rejecting));
  const reject = getButton("Reject", rejecting);
  assert.equal(reject.disabled, true, "Reject needs a reason first");
  await type(getByAriaLabel("Rejection reason", rejecting), "the cited source doesn't mention this address");
  assert.equal(reject.disabled, false);
  await click(reject);
  await waitFor(() => text().includes(`Rejected “${TO_REJECT.name}”.`), "the reject notice");
  await waitFor(() => ONE_PENDING.test(text()), "only their own left");

  // What the server now holds, read back over the same API.
  const moderatorToken = tokens.get(MODERATOR) as string;
  const confirmed = await api<{ submissions: Submission[] }>("GET", "/labels/submissions?status=confirmed", moderatorToken);
  assert.deepEqual(confirmed.body.submissions.map((s) => s.name), [TO_CONFIRM.name]);
  const rejected = await api<{ submissions: Submission[] }>("GET", "/labels/submissions?status=rejected", moderatorToken);
  assert.deepEqual(rejected.body.submissions.map((s) => s.name), [TO_REJECT.name]);
  assert.ok(JSON.stringify(rejected.body.submissions[0]).includes("the cited source doesn't mention this address"), "the reason is stored");

  // Refresh re-reads the real queue: the same one left.
  await click(getButton("Refresh"));
  await waitFor(() => ONE_PENDING.test(text()) && text().includes(OWN.name), "the refreshed queue");
  assert.throws(() => card(TO_CONFIRM.name));
  assert.throws(() => card(TO_REJECT.name));
  assert.deepEqual(consoleErrors, []);
});
