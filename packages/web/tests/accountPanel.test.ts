import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement, type ComponentType } from "react";
import {
  cleanup,
  click,
  consoleErrors,
  getAllByRole,
  getButton,
  getByLabelText,
  getSubmitButton,
  render,
  text,
  type,
  waitFor,
} from "./harness/render.ts";
import { FixedBalanceAdapter, startStack, type Stack } from "./harness/servers.ts";

// The log-in / sign-up form against the real accounts API (real argon2, real temp-file store).

const PASSWORD = "correct horse battery staple";
let stack: Stack;
let AccountPanel: ComponentType;

before(async () => {
  stack = await startStack(new FixedBalanceAdapter("ethereum", {}));
  assert.ok((await stack.accountService.signup("taken@example.com", PASSWORD)).ok);
  ({ default: AccountPanel } = await import("../src/AccountPanel.tsx"));
});

after(async () => {
  await stack.close();
});

beforeEach(() => {
  consoleErrors.length = 0;
});
afterEach(cleanup);

async function openForm(): Promise<HTMLFormElement> {
  await render(createElement(AccountPanel));
  await click(await waitFor(() => (text().includes("Log in or sign up") ? getButton("Log in or sign up") : null), "the logged-out prompt"));
  const form = document.querySelector("form");
  assert.ok(form);
  return form;
}

/** The form's one live region: exactly one, so a message can only ever land in it. */
function alertRegion(form: HTMLFormElement): HTMLElement {
  const alerts = getAllByRole("alert", form);
  assert.equal(alerts.length, 1);
  return alerts[0] as HTMLElement;
}

test("the email and password inputs are named by visible labels, in both modes", async () => {
  const form = await openForm();
  for (const mode of ["Log in", "Sign up"]) {
    await click(getButton(mode, form));
    const email = getByLabelText("Email", form);
    const password = getByLabelText("Password", form);
    assert.equal(email.type, "email", mode);
    assert.equal(password.type, "password", mode);
    // The label is the control's own <label>, not a nearby bit of text.
    assert.equal(email.labels?.length, 1, mode);
    assert.equal(password.labels?.length, 1, mode);
  }
  assert.deepEqual(consoleErrors, []);
});

test("a failed log in puts the API's real error into the role=alert region that was already there", async () => {
  const form = await openForm();
  // Mounted, and empty, before anything goes wrong: a screen reader only announces text added to
  // a live region it already knew about.
  const region = alertRegion(form);
  assert.equal(text(region).trim(), "");

  await type(getByLabelText("Email", form), "taken@example.com");
  await type(getByLabelText("Password", form), "not the right password");
  await click(getSubmitButton(form));

  await waitFor(() => text(region).includes("wrong email or password"), "the log-in error");
  assert.equal(alertRegion(form), region, "the same region received the message");
  assert.deepEqual(consoleErrors, []);
});

test("a failed sign up (email taken) is announced the same way, and switching mode clears it", async () => {
  const form = await openForm();
  await click(getButton("Sign up", form));
  const region = alertRegion(form);

  await type(getByLabelText("Email", form), "taken@example.com");
  await type(getByLabelText("Password", form), "another long enough password");
  await click(getSubmitButton(form));

  await waitFor(() => text(region).includes("an account with that email already exists"), "the sign-up error");
  assert.equal(alertRegion(form), region);

  await click(getButton("Log in", form));
  assert.equal(text(alertRegion(form)).trim(), "");
  assert.deepEqual(consoleErrors, []);
});
