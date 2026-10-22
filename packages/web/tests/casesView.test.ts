import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement, type ComponentType } from "react";
import { window } from "./harness/env.ts";
import { choose, fill, getByPlaceholder, getControl, getRegion, queryRegion } from "./harness/forms.ts";
import { logInAs as realLogIn } from "./harness/login.ts";
import { cleanup, click, consoleErrors, getButton, render, text, waitFor } from "./harness/render.ts";
import { FixedBalanceAdapter, startStack, type Stack } from "./harness/servers.ts";

// Your own private cases, against the real case-management + accounts APIs (real argon2, real
// temp-file stores). Users switch through a real log out / log in, as in the sidebar.

const PASSWORD = "correct horse battery staple";
const ALICE = "alice@example.com";
const BOB = "bob@example.com";
// A real, well-formed public address (the Ethereum beacon-chain deposit contract), used only as
// an input -- the same one @osstrace/case-management's own tests use.
const ETH_ADDR = "0x00000000219ab540356cbb839cbe05303d7705fa";

let stack: Stack;
let CasesView: ComponentType;
const tokens = new Map<string, string>();

before(async () => {
  stack = await startStack(new FixedBalanceAdapter("ethereum", {}));
  for (const email of [ALICE, BOB]) {
    const signup = await stack.accountService.signup(email, PASSWORD);
    assert.ok(signup.ok);
    tokens.set(email, signup.session.token);
  }
  ({ default: CasesView } = await import("../src/CasesView.tsx"));
});

after(async () => {
  await stack.close();
});

beforeEach(() => {
  consoleErrors.length = 0;
});
afterEach(cleanup);

const logInAs = (email: string): Promise<void> => realLogIn(email, PASSWORD);

/** A case's row in the list (a button whose text starts with its title). */
function row(title: string): HTMLButtonElement | null {
  return [...document.querySelectorAll("button")].find((b) => text(b).trim().startsWith(title)) ?? null;
}

async function createCase(title: string, description: string): Promise<void> {
  await click(getButton("New case"));
  await fill(getByPlaceholder("Title"), title);
  await fill(getByPlaceholder("What you're investigating"), description);
  await click(getButton("Create case"));
  // Creating opens the new case.
  await waitFor(() => {
    const region = queryRegion("Case");
    return region !== null && text(region).includes(title);
  }, `case "${title}" opened`);
}

async function backToList(): Promise<void> {
  await click(getButton("← Back to your cases"));
  await waitFor(() => !text().includes("Back to your cases") && !text().includes("Loading…"), "the case list");
}

/** The list item for `address` inside the case's Addresses section. */
function itemFor(address: string): HTMLLIElement | null {
  return [...getRegion("Addresses in this case").querySelectorAll("li")].find((li) => text(li).includes(address)) ?? null;
}

function mustItem(address: string): HTMLLIElement {
  const item = itemFor(address);
  assert.ok(item, `a list item for ${address}`);
  return item;
}

/** GET a case straight from the API as `email` (what the server itself says, not the UI). */
async function apiGetCase(email: string, id: string): Promise<number> {
  const res = await fetch(`${stack.cases.url}/cases/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${tokens.get(email)}` } });
  await res.body?.cancel();
  return res.status;
}

async function apiListCases(email: string): Promise<{ id: string; title: string; status: string; itemCount: number }[]> {
  const res = await fetch(`${stack.cases.url}/cases`, { headers: { authorization: `Bearer ${tokens.get(email)}` } });
  return ((await res.json()) as { cases: { id: string; title: string; status: string; itemCount: number }[] }).cases;
}

test("logged out, the view asks for a log in and offers no case controls", async () => {
  await render(createElement(CasesView));
  await waitFor(() => text().includes("Log in (in the sidebar) to open a case"), "the logged-out prompt");
  assert.ok(!text().includes("New case"));
  assert.deepEqual(consoleErrors, []);
});

test("a case's whole life: create, add an address with a note, edit the note, close (read-only), reopen, delete", async () => {
  await logInAs(ALICE);
  await render(createElement(CasesView));
  await waitFor(() => text().includes("You have no cases yet."), "Alice's empty case list");

  await createCase("Drainer cluster, Oct 2026", "Wallets that received from the drainer contract.");
  assert.ok(text(getRegion("Case")).includes("Wallets that received from the drainer contract."));
  assert.ok(text(getRegion("Addresses in this case")).includes("No addresses in this case yet."));

  // Add an address with a note.
  await choose(getControl<HTMLSelectElement>("Chain"), "ethereum");
  await fill(getControl("Address"), ETH_ADDR);
  await fill(getControl("Note"), "First hop out of the drainer");
  await click(getButton("Add to case"));
  const added = await waitFor(() => itemFor(ETH_ADDR), "the added address");
  assert.ok(text(added).includes("First hop out of the drainer"));
  assert.ok(text(added).includes("ethereum"));
  assert.equal(getControl<HTMLInputElement>("Address").value, "", "the add form is cleared");

  // Edit the note in place.
  await click(getButton("Edit note", added));
  const noteEditor = getControl<HTMLTextAreaElement>("Note", added);
  assert.equal(noteEditor.value, "First hop out of the drainer");
  await fill(noteEditor, "First hop out of the drainer; funds split three ways from here");
  await click(getButton("Save", added));
  await waitFor(() => !text().includes("Save") && text(mustItem(ETH_ADDR)).includes("split three ways"), "the edited note");

  // Close it: read-only from then on.
  await click(getButton("Close case"));
  await waitFor(() => text().includes("Closed cases are read-only."), "the closed case");
  const closedText = text(getRegion("Case"));
  assert.ok(closedText.includes("closed"));
  assert.ok(text().includes("Reopen case"));
  for (const gone of ["Add an address", "Edit note", "Remove", "Close case"]) {
    assert.ok(!text().includes(gone), `"${gone}" is not offered on a closed case`);
  }
  assert.throws(() => getButton("Edit"), /no button named "Edit"/);
  // The note survived closing.
  assert.ok(text(mustItem(ETH_ADDR)).includes("split three ways"));

  // Reopen it: editable again.
  await click(getButton("Reopen case"));
  await waitFor(() => text().includes("Close case"), "the reopened case");
  assert.ok(text().includes("Add an address"));
  assert.ok(getButton("Edit note", mustItem(ETH_ADDR)));

  // The list (and the API) agree on what's in it.
  await backToList();
  // (Going back refetches the list; the row's count updates when that lands.)
  const listed = await waitFor(() => {
    const r = row("Drainer cluster, Oct 2026");
    return r && text(r).includes("1 address") ? r : null;
  }, "the case's row, counting its one address");
  assert.ok(text(listed).trim().endsWith("open"));
  const [stored] = await apiListCases(ALICE);
  assert.ok(stored);
  assert.deepEqual([stored.title, stored.status, stored.itemCount], ["Drainer cluster, Oct 2026", "open", 1]);

  // Delete it (after the browser's confirm dialog).
  await click(listed);
  await waitFor(() => text().includes("Close case"), "the case, opened again");
  const confirms: string[] = [];
  const originalConfirm = window.confirm;
  window.confirm = (message?: string) => {
    confirms.push(message ?? "");
    return true;
  };
  try {
    await click(getButton("Delete"));
    await waitFor(() => text().includes("You have no cases yet."), "the empty list after deleting");
  } finally {
    window.confirm = originalConfirm;
  }
  assert.deepEqual(confirms, ["Delete this case and every address in it? This can't be undone."]);
  assert.equal(await apiGetCase(ALICE, stored.id), 404, "gone server-side too");
  assert.deepEqual(consoleErrors, []);
});

test("privacy: another signed-in user never sees your case, in their list or by id", async () => {
  await logInAs(ALICE);
  await render(createElement(CasesView));
  await waitFor(() => text().includes("You have no cases yet."), "Alice's empty list");
  await createCase("Alice's private investigation", "");
  await fill(getControl("Address"), ETH_ADDR);
  await click(getButton("Add to case"));
  await waitFor(() => itemFor(ETH_ADDR), "Alice's address");
  const [alicesCase] = await apiListCases(ALICE);
  assert.ok(alicesCase);

  // Bob logs in on the same page while Alice's case is open: the view drops it immediately.
  await logInAs(BOB);
  await waitFor(() => text().includes("You have no cases yet."), "Bob's own (empty) list");
  assert.ok(!text().includes("Alice's private investigation"));
  assert.ok(!text().includes(ETH_ADDR));
  // And the server refuses it by id, the same as a case that doesn't exist.
  assert.equal(await apiGetCase(BOB, alicesCase.id), 404);

  await createCase("Bob's own case", "");
  await backToList();
  assert.ok(row("Bob's own case"));
  assert.equal(row("Alice's private investigation"), null);

  // Back as Alice: only her case, never Bob's.
  await logInAs(ALICE);
  await waitFor(() => row("Alice's private investigation"), "Alice's case in her list");
  assert.equal(row("Bob's own case"), null);
  assert.deepEqual(
    (await apiListCases(BOB)).map((c) => c.title),
    ["Bob's own case"],
  );
  assert.deepEqual(consoleErrors, []);
});
