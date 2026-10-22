import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { window } from "./harness/env.ts";
import { cleanup, click, consoleErrors, during, getButton, getByLabelText, getSubmitButton, render, text, type, waitFor } from "./harness/render.ts";
import { FixedBalanceAdapter, startStack, type Stack } from "./harness/servers.ts";

// LabelReview.tsx: the trust-tier badge and byline (pure rendering of a label), and the
// "Suggest a label" form against the real community-labels API. The share-a-private-label mode of
// the same form is tested with the real private-labels server in privateLabelPanel.test.ts.

const PASSWORD = "correct horse battery staple";
const ADDRESS = "0x41675c099f32341bf84bfc5382af534df5c7461a";
let stack: Stack;
let token: string;
let LabelReview: typeof import("../src/LabelReview.tsx");
let session: typeof import("../src/session.ts");

const source = { description: "the project's own docs", url: "https://docs.example.org/treasury", addedAt: "2026-10-20T09:00:00Z" };

before(async () => {
  stack = await startStack(new FixedBalanceAdapter("ethereum", {}));
  const signup = await stack.accountService.signup("suggester@example.com", PASSWORD);
  assert.ok(signup.ok);
  token = signup.session.token;
  session = await import("../src/session.ts");
  LabelReview = await import("../src/LabelReview.tsx");
});

after(async () => {
  await stack.close();
});

beforeEach(() => {
  consoleErrors.length = 0;
});
afterEach(cleanup);

/** Picks an <option> the way a user does: React only sees it through a real change event. */
async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
    if (!setValue) throw new Error("no HTMLSelectElement value setter");
    setValue.call(select, value);
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}

async function mySubmissions(): Promise<{ name: string; confidence: string; status: string; source: { url: string } }[]> {
  const res = await fetch(`${stack.accounts.url}/labels/submissions/mine`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  return ((await res.json()) as { submissions: { name: string; confidence: string; status: string; source: { url: string } }[] }).submissions;
}

test("ReviewBadge and SubmissionByline: one distinct badge + byline per review tier, nothing for an ingested label", async () => {
  const { ReviewBadge, SubmissionByline } = LabelReview;
  const show = async (label: Parameters<typeof ReviewBadge>[0]["label"]): Promise<string> => {
    const view = await render(createElement("div", null, createElement(ReviewBadge, { label }), createElement(SubmissionByline, { label })));
    const shown = text(view.container).trim();
    await view.unmount();
    return shown;
  };

  assert.equal(await show({ name: "OFAC: Lazarus", confidence: "verified", source }), "", "ingested labels aren't in moderation");
  assert.equal(
    await show({ name: "x", confidence: "verified", source, reviewStatus: "community", submittedAt: "2026-10-21T10:00:00Z" }),
    "COMMUNITY · UNREVIEWEDCommunity submission, 2026-10-21",
  );
  assert.equal(
    await show({
      name: "x",
      confidence: "verified",
      source,
      reviewStatus: "confirmed",
      submittedAt: "2026-10-21T10:00:00Z",
      confirmedAt: "2026-10-22T08:00:00Z",
    }),
    "✓ CONFIRMEDCommunity submission, 2026-10-21 · confirmed by a moderator 2026-10-22",
  );
  const selfAttested = await show({
    name: "x",
    confidence: "verified",
    source,
    reviewStatus: "self-attested",
    submittedAt: "2026-10-21T10:00:00Z",
    attestation: { scheme: "eip191", message: "OSSTrace label statement", signature: "0xsig" },
  });
  assert.ok(selfAttested.startsWith("SELF-ATTESTED · SIGNED BY OWNERSelf-attested by whoever controls this address, 2026-10-21"), selfAttested);
  assert.ok(selfAttested.includes("OSSTrace label statement") && selfAttested.includes("eip191 signature: 0xsig"));
  assert.deepEqual(consoleErrors, []);
});

test("LabelSubmitForm signed out: an invitation to log in, no form", async () => {
  await render(createElement(LabelReview.LabelSubmitForm, { chain: "ethereum", address: ADDRESS, onSubmitted: () => {} }));
  await waitFor(() => text().includes("Log in to suggest a label for this address."), "the logged-out prompt");
  assert.equal(document.querySelector("form"), null);
  assert.deepEqual(consoleErrors, []);
});

test("LabelSubmitForm: a real submission, then the server's own refusal of a bad source shown in the form", async () => {
  assert.equal(await during(session.signIn("login", "suggester@example.com", PASSWORD)), null);
  let submitted = 0;
  await render(createElement(LabelReview.LabelSubmitForm, { chain: "ethereum", address: ADDRESS, onSubmitted: () => submitted++ }));

  await click(await waitFor(() => (text().includes("Suggest a public label") ? getButton("Suggest a public label") : null), "the open button"));
  const form = document.querySelector("form");
  assert.ok(form);
  assert.equal(form.getAttribute("aria-label"), "Suggest a label");
  await type(getByLabelText("Label", form), "Example DAO: Treasury");
  await type(getByLabelText("Source URL", form), "https://docs.example.org/treasury");
  await type(getByLabelText("What the source says", form), "the DAO's docs list this as its treasury");
  const confidence = form.querySelector("select");
  assert.ok(confidence);
  await choose(confidence, "predicted");
  await click(getSubmitButton(form));

  await waitFor(() => text().includes("Submitted. It shows as Community (unreviewed) until a moderator reviews it."), "the success message");
  assert.equal(submitted, 1, "onSubmitted ran once");
  assert.equal(document.querySelector("form"), null, "the form closes after a successful submit");
  const mine = await mySubmissions();
  assert.equal(mine.length, 1);
  assert.equal(mine[0]?.name, "Example DAO: Treasury");
  assert.equal(mine[0]?.confidence, "predicted");
  assert.equal(mine[0]?.status, "community");

  // Reopened, the fields are empty again. A source the browser accepts as a URL but the server
  // refuses (not a public web address) comes back as the API's own message, inline.
  await click(getButton("Suggest a public label"));
  const again = document.querySelector("form");
  assert.ok(again);
  assert.equal(getByLabelText("Label", again).value, "");
  await type(getByLabelText("Label", again), "Another name");
  await type(getByLabelText("Source URL", again), "http://localhost/private-note");
  await type(getByLabelText("What the source says", again), "my own notes");
  await click(getSubmitButton(again));
  const error = await waitFor(() => again.querySelector(".text-danger")?.textContent, "the server's refusal");
  assert.match(error, /source\.url/, "the server's parsePublicUrl message, not a client-side one");
  assert.equal(submitted, 1, "a refused submission doesn't count as submitted");
  assert.ok(document.querySelector("form"), "the form stays open with what was typed");
  assert.equal((await mySubmissions()).length, 1);
  assert.deepEqual(consoleErrors, []);
});
