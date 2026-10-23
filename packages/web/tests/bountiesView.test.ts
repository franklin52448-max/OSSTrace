import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { act, createElement, type ComponentType } from "react";
import { window } from "./harness/env.ts";
import { choose, fill, getByPlaceholder, getControl } from "./harness/forms.ts";
import { cleanup, click, consoleErrors, getButton, render, text, waitFor } from "./harness/render.ts";
import { startNewServer, type RunningNewServer } from "./harness/newServer.ts";

/**
 * The bounty board against a real, booted `@osstrace/server` instance (ADR 0022): real wallet
 * challenge/verify, real cookie session, real SQLite. Every "log in" below is the real
 * challenge/verify flow with a real ed25519 keypair, done directly through `serverSession.ts`
 * (not through the header's UI) purely for test speed -- `AccountPanel`'s own UI-level wallet
 * flow already has its own coverage in `accountPanel.test.ts`.
 *
 * There's no more "moderator" role (ADR 0009's intent is now: only the bounty's own opener can
 * resolve/cancel it -- see routes/bounties.ts). Deposit verification is a real server-side RPC/
 * Blockscout call; this fakes the outbound side of THAT (a different fetch than the one below,
 * which fakes nothing -- it just adds the Origin header and cookie-jar behavior a real browser
 * gives serverApiCall for free and Node's bare fetch doesn't).
 */

const WEB_ORIGIN = "http://localhost:5301";

let jarCookie = "";
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const res = await realFetch(input, { ...init, headers: { ...init.headers, origin: WEB_ORIGIN, ...(jarCookie ? { cookie: jarCookie } : {}) } });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) jarCookie = setCookie.split(";")[0] ?? "";
    return res;
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

/** The outbound fetch the SERVER (not the test) uses to reach Solana RPC / Blockscout / Esplora for deposit verification. */
const depositMocks: { solTx?: unknown; bsTx?: unknown; bsTransfers?: unknown; btcTx?: unknown } = {};
function mockOutboundFetch(): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") return new Response(JSON.stringify({ result: depositMocks.solTx ?? null }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/api/tx/")) return depositMocks.btcTx ? new Response(JSON.stringify(depositMocks.btcTx), { status: 200 }) : new Response("Transaction not found", { status: 404 });
    if (url.includes("/token-transfers")) return new Response(JSON.stringify(depositMocks.bsTransfers ?? { items: [] }), { status: 200 });
    if (url.includes("/api/v2/transactions/")) return new Response(JSON.stringify(depositMocks.bsTx ?? { status: null, value: "0", to: null, from: null }), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const SOL_WALLET = "11111111111111111111111111111111";
const ETH_WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const BTC_WALLET = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

function solanaKeypair(seed: string): { address: string; secretKey: Uint8Array } {
  const kp = nacl.sign.keyPair.fromSeed(createHash("sha256").update(seed).digest());
  return { address: bs58.encode(Buffer.from(kp.publicKey)), secretKey: kp.secretKey };
}

/** Real challenge -> sign -> verify against the booted server, bypassing the header's UI for speed. */
async function logInAs(seed: string): Promise<void> {
  const { serverChallenge, serverSignOut, serverVerify } = await import("../src/serverSession.ts");
  await act(async () => serverSignOut());
  const { address, secretKey } = solanaKeypair(seed);
  const chal = await serverChallenge("solana", address);
  if (!chal.ok) throw new Error(`challenge failed: ${chal.message}`);
  const signature = Buffer.from(nacl.sign.detached(new TextEncoder().encode(chal.body.message), secretKey)).toString("base64");
  const err = await act(async () => serverVerify("solana", address, chal.body.nonce, signature));
  if (err) throw new Error(`verify failed: ${err}`);
}

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

let server: RunningNewServer;
let BountiesView: ComponentType;

before(async () => {
  server = await startNewServer([WEB_ORIGIN], {
    // testHooks: true also skips the per-IP wallet-verify throttle (routes/auth.ts) -- this file
    // does many real logins from one IP, which a real deployment's abuse guard would otherwise
    // (correctly) rate-limit.
    configOverrides: { depositWallets: { ethereum: ETH_WALLET, solana: SOL_WALLET, bitcoin: BTC_WALLET }, testHooks: true },
    fetchImpl: mockOutboundFetch(),
  });
  process.env["VITE_SERVER_URL"] = server.url;
  ({ default: BountiesView } = await import("../src/BountiesView.tsx"));
});

after(async () => {
  delete process.env["VITE_SERVER_URL"];
  await server.close();
});

beforeEach(() => {
  consoleErrors.length = 0;
  depositMocks.solTx = undefined;
  depositMocks.bsTx = undefined;
  depositMocks.bsTransfers = undefined;
  depositMocks.btcTx = undefined;
});
afterEach(async () => {
  await cleanup(); // unmount first -- nothing left subscribed to warn about an un-act()-ed state change
  const { serverSignOut } = await import("../src/serverSession.ts");
  await serverSignOut();
  jarCookie = "";
});

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
  await fill(getByPlaceholder("Note for the"), note);
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

test("open two bounties, submit PRs, the opener (not a moderator -- there is no such role) claims one, and cancels the other", async () => {
  await render(createElement(BountiesView));

  // 1. The opener posts both bounties.
  await logInAs("opener");
  await openBounty(ALPHA);
  await openBounty(BETA);
  // Newest first, both open.
  const rows = [row(BETA.title), row(ALPHA.title)];
  assert.ok(rows[0] && rows[1]);
  assert.ok(rows[0].compareDocumentPosition(rows[1]) & window.Node.DOCUMENT_POSITION_FOLLOWING, "Beta (newer) is listed first");
  assert.ok(text(rows[1]).includes(ALPHA.reward) && text(rows[1]).includes("Open"));

  // 2. Two other wallets submit PRs against Alpha. Neither can claim or cancel.
  await logInAs("solver");
  await openRow(ALPHA.title);
  assert.ok(text().includes(ALPHA.description));
  await waitFor(() => text().includes("No submissions yet."), "the (empty) submissions list");
  await submitPr(SOLVER_PR, "Implements it against /trace/path directly.");
  assert.ok(!text().includes("Mark claimed"), "a non-opener can't claim");
  assert.ok(!text().includes("Cancel this bounty"), "only the opener can cancel");
  await backToBoard();

  await logInAs("runner-up");
  await openRow(ALPHA.title);
  await submitPr(RUNNER_UP_PR, "");
  await backToBoard();

  // 3. The opener (no separate moderator role exists) records the solver's PR as the winner.
  await logInAs("opener");
  await openRow(ALPHA.title);
  const solverItem = await waitFor(() => [...document.querySelectorAll("li")].find((li) => text(li).includes(SOLVER_PR)) ?? null, "the solver's submission");
  await click(getButton("Mark claimed", solverItem));
  await waitFor(() => text().includes("Claimed by"), "the claimed banner");
  assert.ok(!text().includes("Mark claimed"), "nothing left to claim");
  await backToBoard();

  // Anyone reopening it sees the recorded outcome of every submission: one accepted, the rest rejected.
  await logInAs("solver");
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
  await logInAs("opener");
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
  await backToBoard();

  // The board shows both outcomes, and the API agrees.
  assert.match(text(await waitFor(() => row(ALPHA.title), "Alpha's row")).trim(), /Claimed$/);
  assert.match(text(await waitFor(() => row(BETA.title), "Beta's row")).trim(), /Cancelled$/);
  const bounties = (await (await fetch(`${server.url}/api/bounties`)).json()) as { title: string; status: string; cancellationReason?: string }[];
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

test("a wallet that didn't open the bounty can't cancel it, even with a direct API call", async () => {
  await render(createElement(BountiesView));
  await logInAs("cancel-opener");
  await openBounty({ title: "Not yours to cancel", description: ALPHA.description, reward: "R" });
  const bountyId = ((await (await fetch(`${server.url}/api/bounties`)).json()) as { id: string; title: string }[]).find((b) => b.title === "Not yours to cancel")!.id;

  await logInAs("cancel-stranger");
  const res = await fetch(`${server.url}/api/bounties/${bountyId}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: WEB_ORIGIN, ...(jarCookie ? { cookie: jarCookie } : {}) },
    body: JSON.stringify({ reason: "nope" }),
  });
  assert.equal(res.status, 403);
});

// --- Funding / deposits (ADR 0020) --------------------------------------------------------------
// The "connect a wallet and send" half of DepositPanel isn't exercised here -- jsdom has no real
// wallet extension to connect to, and src/wallets.ts has its own real tests. This covers what the
// board itself controls: display, the "paste a reference" fallback, and how the real bounties
// API's responses (via a faked outbound deposit-verification fetch) show up in the UI.

const REAL_SIG = "A".repeat(64); // valid base58 charset + length -- routes into real (mocked) RPC verification

test("Funding: shows the configured receiving wallets to everyone, with no deposits yet, no login needed", async () => {
  await render(createElement(BountiesView));
  await logInAs("funding-display-opener");
  await openBounty({ title: "Funding display check", description: ALPHA.description, reward: "whatever backers send" });
  await openRow("Funding display check");
  await waitFor(() => text().includes(SOL_WALLET), "the configured Solana wallet");
  assert.ok(text().includes(ETH_WALLET), "the configured Ethereum wallet is shown too");
  assert.ok(text().includes(BTC_WALLET), "and the configured Bitcoin wallet");
  assert.ok(text().includes("No deposits recorded yet"));
  await backToBoard();
});

test("Funding: signed out, the panel explains how to back it but shows no form", async () => {
  await render(createElement(BountiesView));
  await logInAs("funding-signed-out-opener");
  await openBounty({ title: "Funding signed-out check", description: ALPHA.description, reward: "whatever" });

  const { serverSignOut } = await import("../src/serverSession.ts");
  await act(async () => serverSignOut());
  await waitFor(() => text().includes("Log in to open a bounty"), "the signed-out board");

  await openRow("Funding signed-out check");
  await waitFor(() => text().includes("Funding"), "the Funding section");
  assert.ok(text().includes("Log in to back this bounty"));
  assert.equal(row("Back this bounty"), null);
});

test("Funding: pasting an already-verified real tx reference records it, sums per asset, and refuses a second submission of the same one", async () => {
  await render(createElement(BountiesView));
  await logInAs("funding-paste-opener");
  await openBounty({ title: "Funding paste-flow check", description: ALPHA.description, reward: "backer-funded" });
  const bountyId = ((await (await fetch(`${server.url}/api/bounties`)).json()) as { id: string; title: string }[]).find((b) => b.title === "Funding paste-flow check")!.id;

  // The signed-in depositor's own wallet must be the tx's real sender -- the deposit route
  // requires that match (anyone could otherwise attach someone else's public on-chain payment to
  // a bounty of their own choosing).
  const payer = solanaKeypair("funding-depositor").address;
  depositMocks.solTx = {
    transaction: { message: { accountKeys: [payer, SOL_WALLET], instructions: [] } },
    meta: { err: null, preBalances: [5_000_000_000, 1_000_000_000], postBalances: [3_500_000_000, 3_500_000_000] }, // +2.5 SOL to the configured wallet
  };

  await logInAs("funding-depositor");
  await openRow("Funding paste-flow check");
  await click(await waitFor(() => (text().includes("Back this bounty") ? getButton("Back this bounty") : null), "the Back this bounty button"));
  await fill(getByPlaceholder("Transaction signature"), REAL_SIG);
  await click(getButton("Verify & record"));
  await waitFor(() => text().includes("2.5 SOL"), "the recorded deposit's summed total");
  assert.ok(text().includes(payer.slice(0, 6)), "the real sender address is shown");

  // A successful submission closes the form -- reopen it to try the same reference again.
  // The real backend's idempotency rule: the same reference can't be recorded twice.
  await click(await waitFor(() => (text().includes("Back this bounty") ? getButton("Back this bounty") : null), "the Back this bounty button, reopened"));
  await fill(getByPlaceholder("Transaction signature"), REAL_SIG);
  await click(getButton("Verify & record"));
  await waitFor(() => text().includes("already been recorded"), "the conflict error");

  const b = (await (await fetch(`${server.url}/api/bounties/${bountyId}`)).json()) as { deposits: unknown[] };
  assert.equal(b.deposits.length, 1, "still only one deposit despite the repeated submission");
});

test("Funding: a reference the verifier rejects shows the real server message and is never recorded", async () => {
  await render(createElement(BountiesView));
  await logInAs("funding-rejection-opener");
  await openBounty({ title: "Funding rejection check", description: ALPHA.description, reward: "backer-funded" });
  const unverifiedSig = "5".repeat(64);
  depositMocks.solTx = {
    transaction: { message: { accountKeys: ["SomeoneElse11111111111111111111111111111", SOL_WALLET], instructions: [] } },
    meta: { err: null, preBalances: [1_000_000_000, 1_000_000_000], postBalances: [1_000_000_000, 1_000_000_000] }, // no balance change -> wrong_wallet
  };

  await logInAs("funding-depositor-2");
  await openRow("Funding rejection check");
  await click(await waitFor(() => (text().includes("Back this bounty") ? getButton("Back this bounty") : null), "the Back this bounty button"));
  await fill(getByPlaceholder("Transaction signature"), unverifiedSig);
  await click(getButton("Verify & record"));
  await waitFor(() => text().includes("doesn't pay the configured deposit wallet"), "the real wrong_wallet message");
  assert.ok(text().includes("No deposits recorded yet"), "nothing was recorded");
});

test("Funding: Bitcoin is paste-only -- picking it in the paste form asks for a txid and records a verified payment without any sender match", async () => {
  await render(createElement(BountiesView));
  await logInAs("funding-btc-opener");
  await openBounty({ title: "Funding bitcoin check", description: ALPHA.description, reward: "backer-funded" });
  depositMocks.btcTx = {
    status: { confirmed: true },
    vin: [{ prevout: { scriptpubkey_address: "bc1qsomeoneelsesinput0000000000000000000000" } }],
    vout: [{ scriptpubkey_address: BTC_WALLET, value: 250_000 }],
  };

  // A Solana-account user, whose own wallet has nothing to do with the BTC payment.
  await logInAs("funding-btc-depositor");
  await openRow("Funding bitcoin check");
  await click(await waitFor(() => (text().includes("Back this bounty") ? getButton("Back this bounty") : null), "the Back this bounty button"));
  const chainPicker = getControl<HTMLSelectElement>("Payment chain");
  assert.deepEqual([...chainPicker.options].map((o) => o.value), ["solana", "ethereum", "bitcoin"]);
  await choose(chainPicker, "bitcoin");
  assert.ok(text().includes("Bitcoin can't be sent from this page"), "the paste-only explanation");
  await fill(getByPlaceholder("Transaction ID (txid)"), "ab".repeat(32));
  await click(getButton("Verify & record"));
  await waitFor(() => text().includes("0.0025 BTC"), "the recorded Bitcoin deposit's total");
});
