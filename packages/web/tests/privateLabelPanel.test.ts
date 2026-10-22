import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement, useState } from "react";
import { cleanup, click, consoleErrors, during, getButton, getByLabelText, getSubmitButton, render, settle, text, type, waitFor } from "./harness/render.ts";
import { FixedBalanceAdapter, startStack, type Stack } from "./harness/servers.ts";

// The private-label panel against the real @osstrace/private-labels API (owner-only labels,
// ADR 0004), and its "Share as Community label" hand-off to LabelSubmitForm (ADR 0017), whose
// draft route reads the same private label through the real community-labels API.

const PASSWORD = "correct horse battery staple";
const OWNER = "owner@example.com";
const OTHER = "other@example.com";
const ADDRESS = "0x41675c099f32341bf84bfc5382af534df5c7461a";
const UNLABELLED = "0x252a8bd2319d8a555b872990601221b3a2053bce";

let stack: Stack;
let session: typeof import("../src/session.ts");
let PrivateLabelPanel: typeof import("../src/PrivateLabelPanel.tsx").default;
let LabelSubmitForm: typeof import("../src/LabelReview.tsx").LabelSubmitForm;
const tokens = new Map<string, string>();

/** The owner's label for an address, read straight from the real private-labels API. */
async function storedLabel(email: string, address = ADDRESS): Promise<string | null> {
  const res = await fetch(`${stack.privateLabels.url}/private-labels/ethereum/${address}`, {
    headers: { authorization: `Bearer ${tokens.get(email)}` },
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { label: { label: string } | null }).label?.label ?? null;
}

async function signInAs(email: string): Promise<void> {
  await during(session.signOut());
  assert.equal(await during(session.signIn("login", email, PASSWORD)), null);
}

/** The page's wiring (App.tsx's report view): the panel's Share button opens the form in share mode. */
function PanelWithShare({ address }: { address: string }) {
  const [shareRequest, setShareRequest] = useState(0);
  return createElement(
    "div",
    null,
    createElement(PrivateLabelPanel, { chain: "ethereum", address, onShare: () => setShareRequest((n) => n + 1) }),
    createElement(LabelSubmitForm, { chain: "ethereum", address, onSubmitted: () => {}, shareRequest }),
  );
}

const panel = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>('section[aria-label="Your private label"]');
  assert.ok(found, "the private label panel");
  return found;
};

before(async () => {
  stack = await startStack(new FixedBalanceAdapter("ethereum", {}));
  for (const email of [OWNER, OTHER]) {
    const signup = await stack.accountService.signup(email, PASSWORD);
    assert.ok(signup.ok);
    tokens.set(email, signup.session.token);
  }
  session = await import("../src/session.ts");
  ({ default: PrivateLabelPanel } = await import("../src/PrivateLabelPanel.tsx"));
  ({ LabelSubmitForm } = await import("../src/LabelReview.tsx"));
});

after(async () => {
  await stack.close();
});

beforeEach(() => {
  consoleErrors.length = 0;
});
afterEach(cleanup);

test("signed out: no panel (the report shows one combined log-in prompt instead)", async () => {
  await render(createElement(PrivateLabelPanel, { chain: "ethereum", address: ADDRESS }));
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(text().trim(), "", "nothing rendered, not even a hint of a label");
  assert.equal(document.querySelector('section[aria-label="Your private label"]'), null);
  assert.deepEqual(consoleErrors, []);
});

test("save, read back after a remount, edit, delete: a real round trip through the private-labels API", async () => {
  await signInAs(OWNER);
  const first = await render(createElement(PrivateLabelPanel, { chain: "ethereum", address: ADDRESS }));
  await waitFor(() => text(panel()).includes("You haven't labelled this address."), "the empty state");

  // Add.
  await click(getButton("Add private label", panel()));
  const save = getButton("Save", panel());
  assert.equal(save.disabled, true, "can't save an empty label");
  await type(getByLabelText("Private label", panel()), "my cold wallet");
  await click(save);
  await waitFor(() => text(panel()).includes("“my cold wallet”"), "the saved label");
  assert.equal(await storedLabel(OWNER), "my cold wallet");

  // A fresh mount reads it back from the server, not from component state.
  await first.unmount();
  const second = await render(createElement(PrivateLabelPanel, { chain: "ethereum", address: ADDRESS }));
  await waitFor(() => text(panel()).includes("“my cold wallet”"), "the label read back");

  // Edit: the input starts with the current text.
  await click(getButton("Edit", panel()));
  const input = getByLabelText("Private label", panel());
  assert.equal(input.value, "my cold wallet");
  await type(input, "my old cold wallet");
  await click(getButton("Save", panel()));
  await waitFor(() => text(panel()).includes("“my old cold wallet”"), "the edited label");
  assert.equal(await storedLabel(OWNER), "my old cold wallet");

  // Remove.
  await click(getButton("Remove", panel()));
  await waitFor(() => text(panel()).includes("You haven't labelled this address."), "the removed state");
  assert.equal(await storedLabel(OWNER), null);
  await second.unmount();
  assert.deepEqual(consoleErrors, []);
});

test("removing a label already deleted elsewhere (a 404) ends in the same state, no error", async () => {
  await signInAs(OWNER);
  await render(createElement(PrivateLabelPanel, { chain: "ethereum", address: ADDRESS }));
  await click(await waitFor(() => (text().includes("Add private label") ? getButton("Add private label", panel()) : null), "the empty state"));
  await type(getByLabelText("Private label", panel()), "deleted in another tab");
  await click(getButton("Save", panel()));
  await waitFor(() => text(panel()).includes("“deleted in another tab”"), "the saved label");

  const res = await fetch(`${stack.privateLabels.url}/private-labels/ethereum/${ADDRESS}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${tokens.get(OWNER)}` },
  });
  assert.equal(res.status, 204);

  await click(getButton("Remove", panel()));
  await waitFor(() => text(panel()).includes("You haven't labelled this address."), "the removed state");
  assert.equal(panel().querySelector('[role="alert"]'), null, "no error shown for the 404");
  assert.deepEqual(consoleErrors, []);
});

test("another account sees none of the owner's label", async () => {
  await signInAs(OWNER);
  const mine = await render(createElement(PrivateLabelPanel, { chain: "ethereum", address: ADDRESS }));
  await click(await waitFor(() => (text().includes("Add private label") ? getButton("Add private label", panel()) : null), "the empty state"));
  await type(getByLabelText("Private label", panel()), "only mine");
  await click(getButton("Save", panel()));
  await waitFor(() => text(panel()).includes("“only mine”"), "the owner's label");
  await mine.unmount();

  await signInAs(OTHER);
  await render(createElement(PrivateLabelPanel, { chain: "ethereum", address: ADDRESS }));
  await waitFor(() => text(panel()).includes("You haven't labelled this address."), "the other account's (empty) view");
  assert.ok(!text().includes("only mine"));
  assert.equal(await storedLabel(OWNER), "only mine", "the owner's label is still there");
  assert.deepEqual(consoleErrors, []);
});

test("Share as Community label: the form is pre-filled from the real draft route, needs a source, and leaves the private label as it was", async () => {
  await signInAs(OWNER);
  // The owner's label from the previous test ("only mine") is what's shared.
  assert.equal(await storedLabel(OWNER), "only mine");
  await render(createElement(PanelWithShare, { address: ADDRESS }));
  await click(await waitFor(() => (text().includes("Share as Community label") ? getButton("Share as Community label", panel()) : null), "the share button"));

  const form = await waitFor(() => document.querySelector<HTMLFormElement>('form[aria-label="Share your private label as a Community label"]'), "the share form");
  await waitFor(() => getByLabelText("Label", form).value === "only mine", "the name pre-filled from the draft");
  assert.equal(getByLabelText("Source URL", form).value, "", "the source is never pre-filled");
  assert.equal(getByLabelText("What the source says", form).value, "");

  await type(getByLabelText("Source URL", form), "https://docs.example.org/wallets");
  await type(getByLabelText("What the source says", form), "the docs list this wallet");
  await click(getSubmitButton(form));
  await waitFor(() => text().includes("Shared. The public copy shows as Community (unreviewed)"), "the shared message");

  const res = await fetch(`${stack.accounts.url}/labels/submissions/mine`, { headers: { authorization: `Bearer ${tokens.get(OWNER)}` } });
  const { submissions } = (await res.json()) as { submissions: { name: string; status: string; source: { url: string } }[] };
  assert.deepEqual(
    submissions.map((s) => [s.name, s.status, s.source.url]),
    [["only mine", "community", "https://docs.example.org/wallets"]],
  );
  assert.equal(await storedLabel(OWNER), "only mine", "the private label is unchanged");
  assert.ok(text(panel()).includes("“only mine”"));
  assert.deepEqual(consoleErrors, []);
});

test("Share for an address with no private label: the draft route's refusal is shown in the form", async () => {
  await signInAs(OWNER);
  assert.equal(await storedLabel(OWNER, UNLABELLED), null);
  await render(createElement(LabelSubmitForm, { chain: "ethereum", address: UNLABELLED, onSubmitted: () => {}, shareRequest: 1 }));
  const form = await waitFor(() => document.querySelector<HTMLFormElement>('form[aria-label="Share your private label as a Community label"]'), "the share form");
  const error = await waitFor(() => form.querySelector(".text-danger")?.textContent, "the draft route's error");
  // The real lookup ran and found nothing (not "sharing isn't enabled on this server").
  assert.equal(error, "you have no private label for that address");
  assert.equal(getByLabelText("Label", form).value, "", "nothing pre-filled");
  assert.deepEqual(consoleErrors, []);
});
