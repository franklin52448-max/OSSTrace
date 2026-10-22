import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement, type ComponentType } from "react";
import { window } from "./harness/env.ts";
import { cleanup, click, consoleErrors, during, getButton, getByLabelText, render, settle, text, type, waitFor } from "./harness/render.ts";
import { FixedBalanceAdapter, startStack, type HeldRequest, type Stack } from "./harness/servers.ts";

// Lookup is retired from the live route (ExplorePage replaces it at #address/...) but kept, with
// its own test coverage, since it's the only place sanctions tags, live updates and community
// label review/moderation still live. This drives it directly (a tiny inline probe of session.ts's
// own restore state sits alongside it for the real session-restore signal -- AccountPanel.tsx no
// longer reflects this session at all, now that it's wallet-based against the *other* backend's
// session, serverSession.ts) rather than through App's hash routing, the same way
// tracerView.test.ts/graphView.test.ts test their own retired components directly.

const A = "0x41675c099f32341bf84bfc5382af534df5c7461a";
const B = "0x252a8bd2319d8a555b872990601221b3a2053bce";
const A_BALANCE = "111.111";
const B_BALANCE = "222.222";
let stack: Stack;
let Lookup: ComponentType<{ chain: "ethereum"; address: string }>;
let useSession: typeof import("../src/session.ts").useSession;

/** The next Explorer request for `address`, held at the server until released. */
const nextRequest = (address: string): Promise<HeldRequest> => during(stack.nextExplorerRequest(`/address/ethereum/${address}`));
const release = (request: HeldRequest): Promise<void> => during(request.release());

type Target = { chain: "ethereum"; address: string } | null;
let setHarnessTarget: ((t: Target) => void) | null = null;

/** Renders session.ts's own restore state as text -- the signal `renderSignedIn` below waits on. */
function SessionStatus() {
  const session = useSession();
  return createElement("div", null, session.status === "signed-in" ? session.user.email : `session:${session.status}`);
}

/** Mounts the session-status probe (for the session-restore signal) alongside Lookup, remounted
 *  under a new key whenever the target changes -- exactly what App()'s own hash routing did for Lookup. */
function Harness({ initial }: { initial: Target }) {
  const [target, setTarget] = useReactState<Target>(initial);
  setHarnessTarget = setTarget;
  return createElement(
    "div",
    null,
    createElement(SessionStatus),
    target ? createElement(Lookup, { key: `${target.chain}:${target.address}`, chain: target.chain, address: target.address }) : null,
  );
}
// Imported lazily (after jsdom's `window` is installed) just like Lookup/session.ts below.
let useReactState: typeof import("react").useState;

before(async () => {
  stack = await startStack(new FixedBalanceAdapter("ethereum", { [A]: A_BALANCE, [B]: B_BALANCE }));
  // A real account with a real session, stored where session.ts keeps it, so the page restores it
  // through the real /accounts/me on load (needed for the label form).
  const signup = await stack.accountService.signup("racer@example.com", "correct horse battery staple");
  assert.ok(signup.ok);
  window.localStorage.setItem("osstrace.session", JSON.stringify(signup.session));
  ({ useState: useReactState } = await import("react"));
  ({ Lookup } = await import("../src/App.tsx"));
  ({ useSession } = await import("../src/session.ts"));
});

after(async () => {
  await stack.close();
});

beforeEach(() => {
  consoleErrors.length = 0;
});
afterEach(cleanup);

/** Remounts Lookup on a new key, the same way App() did via hash navigation — the mechanism this
 *  whole test proves still holds. */
async function navigateTo(address: string): Promise<void> {
  await act(async () => setHarnessTarget?.({ chain: "ethereum", address }));
}

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
  const view = await render(createElement(Harness, { initial: null }));
  await waitFor(() => text().includes("racer@example.com"), "the stored session to be restored");
  return view;
}

test("a slow lookup of A that lands after B's never replaces B's report", async () => {
  const view = await renderSignedIn();

  await navigateTo(A);
  const lookupA = await nextRequest(A);

  // Navigating to a different address before A's response ever arrives: App() remounts Lookup
  // under a new key, so A's in-flight request belongs to an instance that no longer exists.
  await navigateTo(B);
  const lookupB = await nextRequest(B);

  await release(lookupB);
  await waitFor(() => text().includes(B_BALANCE), "B's report");
  await release(lookupA);
  await assertShowsOnlyB();

  await view.unmount();
  assert.deepEqual(consoleErrors, []);
});

test("a label-submission refresh of A that lands after a new lookup of B never replaces B's report", async () => {
  // The user-reachable version: a report is on screen (so a quiet refresh can start), the user
  // suggests a label, which re-fetches A in the background; before that refresh lands they
  // navigate to B.
  const view = await renderSignedIn();

  await navigateTo(A);
  await release(await nextRequest(A));
  await waitFor(() => text().includes(A_BALANCE), "A's report");

  await click(getButton("Suggest a public label"));
  await type(getByLabelText("Label"), "Safe: Singleton 1.4.1");
  await type(getByLabelText("Source URL"), "https://github.com/safe-global/safe-deployments");
  await type(getByLabelText("What the source says"), "Safe's own deployments repo lists this as the v1.4.1 singleton");
  await click(getButton("Submit label")); // a real POST to the community labels API
  const refreshA = await nextRequest(A);

  await navigateTo(B);
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

  await navigateTo(B);
  await release(await nextRequest(B));
  await waitFor(() => text().includes(B_BALANCE), "B's report");
  assert.ok(!text().includes("Wallet of the test"));

  await click(getButton("Suggest a public label"));
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
