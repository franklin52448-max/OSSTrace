import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement, type ComponentType } from "react";
import { window } from "./harness/env.ts";
import {
  cleanup,
  click,
  consoleErrors,
  during,
  getButton,
  getByAriaLabel,
  getByLabelText,
  render,
  requestSubmit,
  settle,
  text,
  type,
  waitFor,
} from "./harness/render.ts";
import { FixedBalanceAdapter, startStack, type HeldRequest, type Stack } from "./harness/servers.ts";

// The Lookup view against the real Explorer, accounts and community-labels APIs. The only thing
// the test controls is when each Explorer response is allowed to leave the server.

const A = "0x41675c099f32341bf84bfc5382af534df5c7461a";
const B = "0x252a8bd2319d8a555b872990601221b3a2053bce";
const A_BALANCE = "111.111";
const B_BALANCE = "222.222";
let stack: Stack;
let App: ComponentType;

/** The next Explorer request for `address`, held at the server until released. */
const nextRequest = (address: string): Promise<HeldRequest> => during(stack.nextExplorerRequest(`/address/ethereum/${address}`));
const release = (request: HeldRequest): Promise<void> => during(request.release());

before(async () => {
  stack = await startStack(new FixedBalanceAdapter("ethereum", { [A]: A_BALANCE, [B]: B_BALANCE }));
  // A real account with a real session, stored where session.ts keeps it, so the page restores it
  // through the real /accounts/me on load (needed for the label form).
  const signup = await stack.accountService.signup("racer@example.com", "correct horse battery staple");
  assert.ok(signup.ok);
  window.localStorage.setItem("osstrace.session", JSON.stringify(signup.session));
  ({ default: App } = await import("../src/App.tsx"));
});

after(async () => {
  await stack.close();
});

beforeEach(() => {
  consoleErrors.length = 0;
});
afterEach(cleanup);

/** Lets anything still in flight land and render, then checks the screen shows B and only B. */
async function assertShowsOnlyB(): Promise<void> {
  for (let i = 0; i < 15; i++) await settle();
  const shown = text();
  assert.ok(shown.includes(B_BALANCE), "B's balance is on screen");
  assert.ok(shown.includes(B), "B's address is on screen");
  assert.ok(!shown.includes(A_BALANCE), "A's balance must not be on screen");
  assert.ok(!shown.includes(A), "A's address must not be on screen");
}

async function renderSignedIn() {
  const view = await render(createElement(App));
  await waitFor(() => text().includes("Signed in as racer@example.com"), "the stored session to be restored");
  return view;
}

test("a slow lookup of A that lands after B's never replaces B's report", async () => {
  const view = await renderSignedIn();
  const input = getByAriaLabel("Address to look up");
  const form = input.form;
  assert.ok(form);

  await type(input, A);
  await click(getButton("Look up"));
  const lookupA = await nextRequest(A);

  // The Look up button is disabled while a lookup is in flight, so a user can't click it again;
  // the form itself still submits (requestSubmit), and the view must not depend on that button
  // for correctness.
  await type(input, B);
  await requestSubmit(form);
  const lookupB = await nextRequest(B);

  await release(lookupB);
  await waitFor(() => text().includes(B_BALANCE), "B's report");
  await release(lookupA);
  await assertShowsOnlyB();

  await view.unmount();
  assert.deepEqual(consoleErrors, []);
});

test("a label-submission refresh of A that lands after a new lookup of B never replaces B's report", async () => {
  // The user-reachable version: a report is on screen (so Look up is enabled), the user suggests
  // a label, which re-fetches A in the background; before that refresh lands they look up B.
  const view = await renderSignedIn();
  const input = getByAriaLabel("Address to look up");

  await type(input, A);
  await click(getButton("Look up"));
  await release(await nextRequest(A));
  await waitFor(() => text().includes(A_BALANCE), "A's report");

  await click(getButton("Suggest a label for this address"));
  await type(getByLabelText("Label"), "Safe: Singleton 1.4.1");
  await type(getByLabelText("Source URL"), "https://github.com/safe-global/safe-deployments");
  await type(getByLabelText("What the source says"), "Safe's own deployments repo lists this as the v1.4.1 singleton");
  await click(getButton("Submit label")); // a real POST to the community labels API
  const refreshA = await nextRequest(A);

  await type(input, B);
  await click(getButton("Look up"));
  await release(await nextRequest(B));
  await waitFor(() => text().includes(B_BALANCE), "B's report");
  await release(refreshA);
  await assertShowsOnlyB();

  await view.unmount();
  assert.deepEqual(consoleErrors, []);
});

test("a refresh nothing has superseded still lands, however slow: the new label shows", async () => {
  // The fix must drop only responses something newer has replaced, never a slow one on its own.
  const view = await renderSignedIn();
  const input = getByAriaLabel("Address to look up");

  await type(input, B);
  await click(getButton("Look up"));
  await release(await nextRequest(B));
  await waitFor(() => text().includes(B_BALANCE), "B's report");
  assert.ok(!text().includes("Wallet of the test"));

  await click(getButton("Suggest a label for this address"));
  await type(getByLabelText("Label"), "Wallet of the test");
  await type(getByLabelText("Source URL"), "https://example.com/source");
  await type(getByLabelText("What the source says"), "the source names this wallet");
  await click(getButton("Submit label"));
  const refreshB = await nextRequest(B);
  for (let i = 0; i < 10; i++) await settle(); // let it sit, slow
  await release(refreshB);

  await waitFor(() => text().includes("Wallet of the test"), "the refreshed report with the new label");
  assert.ok(text().includes("COMMUNITY · UNREVIEWED"));
  assert.ok(text().includes(B_BALANCE));

  await view.unmount();
  assert.deepEqual(consoleErrors, []);
});
