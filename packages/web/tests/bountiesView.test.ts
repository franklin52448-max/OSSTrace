import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement, type ComponentType } from "react";
import { window } from "./harness/env.ts";
import { fill, getByPlaceholder } from "./harness/forms.ts";
import { logInAs as realLogIn } from "./harness/login.ts";
import { cleanup, click, consoleErrors, getButton, render, text, waitFor } from "./harness/render.ts";
import { FixedBalanceAdapter, startStack, type Stack } from "./harness/servers.ts";

// The bounty board against the real bounties + accounts APIs (real argon2, real temp-file
// stores). Every role change is a real log in through the accounts API, the same one the
// sidebar's log-in form uses, so the view sees each user exactly as the server does.

const PASSWORD = "correct horse battery staple";
const OPENER = "opener@example.com";
const SOLVER = "solver@example.com";
const RUNNER_UP = "runner-up@example.com";
const MODERATOR = "moderator@example.com";
const DEPOSITOR = "depositor@example.com";

const ALPHA = {
  title: "Natural-language Tracer agent",
  description: "An agent that answers plain-language on-chain questions by calling Tracer's real tracePath endpoint, never by guessing.",
  reward: "100,000 tokens (token TBD)",
};
const BETA = {
  title: "Solana stake-account decoding",
  description: "Decode Solana stake accounts in the Explorer view: delegation, activation epoch and the validator they point at.",
  reward: "a pizza, paid by me",
};
const SOLVER_PR = "https://github.com/OpenTraceIntelligence/OSSTrace/pull/42";
const RUNNER_UP_PR = "https://github.com/OpenTraceIntelligence/OSSTrace/pull/43";
const CANCEL_REASON = "Superseded by a broader Solana decoding bounty";

let stack: Stack;
let BountiesView: ComponentType;

before(async () => {
  stack = await startStack(new FixedBalanceAdapter("ethereum", {}));
  for (const email of [OPENER, SOLVER, RUNNER_UP, MODERATOR, DEPOSITOR]) {
    assert.ok((await stack.accountService.signup(email, PASSWORD)).ok);
  }
  // The operator's real promotion path (the accounts CLI), as in production.
  assert.ok((await stack.accountService.setRoleAsOperator(MODERATOR, "moderator")).ok);
  ({ default: BountiesView } = await import("../src/BountiesView.tsx"));
});

after(async () => {
  await stack.close();
});

beforeEach(() => {
  consoleErrors.length = 0;
});
afterEach(cleanup);

const logInAs = (email: string): Promise<void> => realLogIn(email, PASSWORD);

/** The board's row for a bounty (a button whose text starts with its title). */
function row(title: string): HTMLButtonElement | null {
  return [...document.querySelectorAll("button")].find((b) => text(b).trim().startsWith(title)) ?? null;
}

async function openRow(title: string): Promise<void> {
  await click(await waitFor(() => row(title), `the "${title}" row on the board`));
  await waitFor(() => text().includes("← All bounties"), `the "${title}" detail view`);
}

async function backToBoard(): Promise<void> {
  await click(getButton("← All bounties"));
  await waitFor(() => !text().includes("← All bounties"), "the board");
}

async function openBounty(bounty: typeof ALPHA): Promise<void> {
  await click(getButton("Open a bounty"));
  await fill(getByPlaceholder("Title"), bounty.title);
  await fill(getByPlaceholder("The feature, in depth"), bounty.description);
  await fill(getByPlaceholder("Your reward offer"), bounty.reward);
  await click(getButton("Open bounty"));
  await waitFor(() => row(bounty.title), `"${bounty.title}" on the board`);
}

async function submitPr(prUrl: string, note: string): Promise<void> {
  await fill(getByPlaceholder("https://github.com/"), prUrl);
  await fill(getByPlaceholder("Note for the moderator"), note);
  await click(getButton("Submit"));
  await waitFor(() => text().includes(prUrl), `the submission ${prUrl} in the list`);
}

test("anonymous: the board is browsable, and opening or submitting needs a log in", async () => {
  await render(createElement(BountiesView));
  await waitFor(() => text().includes("No bounties yet"), "the empty board");
  assert.ok(text().includes("Log in to open a bounty"));
  assert.equal(row("Open a bounty"), null, "no Open a bounty button while logged out");
  assert.deepEqual(consoleErrors, []);
});

test("open two bounties, submit PRs, a moderator claims one, the opener cancels the other", async () => {
  await render(createElement(BountiesView));

  // 1. The opener posts both bounties.
  await logInAs(OPENER);
  await openBounty(ALPHA);
  await openBounty(BETA);
  // Newest first, both open.
  const rows = [row(BETA.title), row(ALPHA.title)];
  assert.ok(rows[0] && rows[1]);
  assert.ok(rows[0].compareDocumentPosition(rows[1]) & window.Node.DOCUMENT_POSITION_FOLLOWING, "Beta (newer) is listed first");
  assert.ok(text(rows[1]).includes(ALPHA.reward) && text(rows[1]).includes("Open"));

  // 2. Two other users submit PRs against Alpha. Neither can claim or cancel.
  await logInAs(SOLVER);
  await openRow(ALPHA.title);
  assert.ok(text().includes(ALPHA.description));
  await waitFor(() => text().includes("No submissions yet."), "the (empty) submissions list");
  await submitPr(SOLVER_PR, "Implements it against /trace/path directly.");
  assert.ok(!text().includes("Mark claimed"), "a regular user can't claim");
  assert.ok(!text().includes("Cancel this bounty"), "only the opener or a moderator can cancel");
  await backToBoard();

  await logInAs(RUNNER_UP);
  await openRow(ALPHA.title);
  await submitPr(RUNNER_UP_PR, "");
  await backToBoard();

  // 3. The moderator records the solver's PR as the winner.
  await logInAs(MODERATOR);
  await openRow(ALPHA.title);
  const solverItem = await waitFor(
    () => [...document.querySelectorAll("li")].find((li) => text(li).includes(SOLVER_PR)) ?? null,
    "the solver's submission",
  );
  await click(getButton("Mark claimed", solverItem));
  await waitFor(() => text().includes("Claimed by"), "the claimed banner");
  assert.ok(!text().includes("Mark claimed"), "nothing left to claim");
  assert.ok(!text().includes("Submit your PR"), "a claimed bounty takes no more submissions");
  await backToBoard();

  // Anyone reopening it sees the recorded outcome of every submission: one accepted, the rest rejected.
  await logInAs(SOLVER);
  await openRow(ALPHA.title);
  const outcomeOf = (prUrl: string): string | null => {
    const item = [...document.querySelectorAll("li")].find((li) => text(li).includes(prUrl));
    return item ? text(item).trim() : null;
  };
  await waitFor(() => outcomeOf(SOLVER_PR)?.endsWith("accepted"), "the solver's submission marked accepted");
  assert.match(outcomeOf(RUNNER_UP_PR) ?? "", /rejected$/);
  assert.ok(text().includes("Claimed by"));
  await backToBoard();

  // 4. The opener cancels Beta (the reason is asked for with the browser's prompt dialog).
  await logInAs(OPENER);
  await openRow(BETA.title);
  const prompts: string[] = [];
  const originalPrompt = window.prompt;
  window.prompt = (message?: string) => {
    prompts.push(message ?? "");
    return CANCEL_REASON;
  };
  try {
    await click(getButton("Cancel this bounty"));
    await waitFor(() => text().includes(`Cancelled: ${CANCEL_REASON}`), "the cancelled banner");
  } finally {
    window.prompt = originalPrompt;
  }
  assert.deepEqual(prompts, ["Reason for cancelling (shown on the bounty)?"]);
  assert.ok(!text().includes("Submit your PR"), "a cancelled bounty takes no submissions");
  await backToBoard();

  // The board shows both outcomes, and the API agrees.
  assert.match(text(await waitFor(() => row(ALPHA.title), "Alpha's row")).trim(), /Claimed$/);
  assert.match(text(await waitFor(() => row(BETA.title), "Beta's row")).trim(), /Cancelled$/);
  const res = await fetch(`${stack.bounties.url}/bounties`);
  const { bounties } = (await res.json()) as { bounties: { title: string; status: string; cancellationReason?: string }[] };
  assert.deepEqual(
    bounties.map((b) => [b.title, b.status]),
    [
      [BETA.title, "cancelled"],
      [ALPHA.title, "claimed"],
    ],
  );
  assert.equal(bounties[0]?.cancellationReason, CANCEL_REASON);
  assert.deepEqual(consoleErrors, []);
});

// --- Funding / deposits (ADR 0020) --------------------------------------------------------------
// The "connect a wallet and send" half of DepositPanel isn't exercised here -- jsdom has no real
// wallet extension to connect to, and `src/wallets.ts` has its own real tests (against real
// recorded mainnet data and a hand-written stand-in provider) in `tests/wallets.test.ts`. This
// covers everything the board itself controls: display, the "paste a reference" fallback, and how
// the real bounties API's responses (via the stand-in `DepositVerifier`) show up in the UI.

const REAL_SIG = "bqTH7u2PJ33gDQwZMy9BXVxABRpgUbY8xSuK6y9PpKYxucFKhiJyiD7JTrH1zxFvMEJGz4847tvotMoP1Ekavaa";

test("Funding: shows the configured receiving wallets to everyone, with no deposits yet, no login needed", async () => {
  await render(createElement(BountiesView));
  await logInAs(OPENER);
  await openBounty({ title: "Funding display check", description: ALPHA.description, reward: "whatever backers send" });
  await openRow("Funding display check");
  await waitFor(() => text().includes(stack.bountyWallets.solana), "the configured Solana wallet");
  assert.ok(text().includes(stack.bountyWallets.ethereum), "the configured Ethereum wallet is shown too");
  assert.ok(text().includes("No deposits recorded yet"));
  await backToBoard();
});

test("Funding: signed out, the panel explains how to back it but shows no form", async () => {
  await render(createElement(BountiesView));
  await logInAs(OPENER);
  await openBounty({ title: "Funding signed-out check", description: ALPHA.description, reward: "whatever" });

  const session = await import("../src/session.ts");
  await act(async () => session.signOut());
  await waitFor(() => text().includes("Log in to open a bounty"), "the signed-out board");

  await openRow("Funding signed-out check");
  await waitFor(() => text().includes("Funding"), "the Funding section");
  assert.ok(text().includes("Log in to back this bounty"));
  assert.equal(row("Back this bounty"), null);
});

test("Funding: pasting an already-verified real tx reference records it, sums per asset, and refuses a second submission of the same one", async () => {
  await render(createElement(BountiesView));
  await logInAs(OPENER);
  await openBounty({ title: "Funding paste-flow check", description: ALPHA.description, reward: "backer-funded" });
  const bountyId = (await (await fetch(`${stack.bounties.url}/bounties`)).json() as { bounties: { id: string; title: string }[] }).bounties.find(
    (b) => b.title === "Funding paste-flow check",
  )!.id;

  stack.bountyDeposits.set("solana", REAL_SIG, {
    ok: true,
    deposit: { asset: "native", amount: "2.5", fromAddress: "SomeRealFunderAddress111111111111111111111", toWallet: stack.bountyWallets.solana },
  });

  await logInAs(DEPOSITOR);
  await openRow("Funding paste-flow check");
  await click(await waitFor(() => (text().includes("Back this bounty") ? getButton("Back this bounty") : null), "the Back this bounty button"));
  await fill(getByPlaceholder("Transaction signature"), REAL_SIG);
  await click(getButton("Verify & record"));
  await waitFor(() => text().includes("2.5 SOL"), "the recorded deposit's summed total");
  assert.ok(text().includes("SomeRealFunderAddress111111111111111111111".slice(0, 6)), "the real sender address is shown");

  // A successful submission closes the form -- reopen it to try the same reference again.
  // The real backend's idempotency rule (ADR 0020 §4): the same reference can't be recorded twice.
  await click(await waitFor(() => (text().includes("Back this bounty") ? getButton("Back this bounty") : null), "the Back this bounty button, reopened"));
  await fill(getByPlaceholder("Transaction signature"), REAL_SIG);
  await click(getButton("Verify & record"));
  await waitFor(() => text().includes("already recorded"), "the already_recorded error");

  const deposits = (await (await fetch(`${stack.bounties.url}/bounties/${bountyId}/deposits`)).json()) as { deposits: unknown[] };
  assert.equal(deposits.deposits.length, 1, "still only one deposit despite the repeated submission");
});

test("Funding: a reference the verifier rejects shows the real server message and is never recorded", async () => {
  await render(createElement(BountiesView));
  await logInAs(OPENER);
  await openBounty({ title: "Funding rejection check", description: ALPHA.description, reward: "backer-funded" });
  const unverifiedSig = "5".repeat(88);
  stack.bountyDeposits.set("solana", unverifiedSig, { ok: false, reason: "wrong_wallet" });

  await logInAs(DEPOSITOR);
  await openRow("Funding rejection check");
  await click(await waitFor(() => (text().includes("Back this bounty") ? getButton("Back this bounty") : null), "the Back this bounty button"));
  await fill(getByPlaceholder("Transaction signature"), unverifiedSig);
  await click(getButton("Verify & record"));
  await waitFor(() => text().includes("didn't pay"), "the real deposit_not_verified message");
  assert.ok(text().includes("No deposits recorded yet"), "nothing was recorded");
});
