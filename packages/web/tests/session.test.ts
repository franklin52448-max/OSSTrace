import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { AccountService, JsonFileAccountStore, createAccountsHandler } from "@osstrace/accounts";
import { window, WEB_ORIGIN } from "./harness/env.ts";
import { cleanup, consoleErrors, during, render, text, waitFor } from "./harness/render.ts";
import { FixedBalanceAdapter, listen, startStack, type Running, type Stack } from "./harness/servers.ts";

// useSession() against the real accounts API. session.ts keeps one module-level session that
// restores itself once, on the first subscriber; so each test loads its own fresh copy of the
// module (a `?case=` import, see harness/env.ts), reading localStorage and VITE_ACCOUNTS_URL as
// they are at that moment, exactly like a fresh page load.

type SessionModule = typeof import("../src/session.ts");

const STORAGE_KEY = "osstrace.session";
const PASSWORD = "correct horse battery staple";
const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";

let stack: Stack;
let loads = 0;

/** A fresh session.ts, as a new page load would get, pointed at `accountsUrl`. */
async function freshSession(accountsUrl: string = stack.accounts.url): Promise<SessionModule> {
  const previous = process.env["VITE_ACCOUNTS_URL"];
  process.env["VITE_ACCOUNTS_URL"] = accountsUrl;
  try {
    return (await import(`../src/session.ts?case=${++loads}`)) as SessionModule;
  } finally {
    process.env["VITE_ACCOUNTS_URL"] = previous;
  }
}

/** The smallest real component on top of the hook: it prints the state it's handed. */
function probe(session: SessionModule) {
  return function SessionProbe() {
    const s = session.useSession();
    const detail = s.status === "signed-in" ? ` as ${s.user.email}` : s.status === "unreachable" ? `: ${s.message}` : "";
    return createElement("output", null, `${s.status}${detail}`);
  };
}

/** Renders the probe and waits for the one-shot restore to finish; returns what it settled on. */
async function restored(session: SessionModule): Promise<string> {
  await render(createElement(probe(session)));
  return waitFor(() => {
    const shown = text().trim();
    return shown && shown !== "checking" ? shown : null;
  }, "the session restore to finish");
}

async function signup(email: string): Promise<{ token: string; expiresAt: string }> {
  const result = await stack.accountService.signup(email, PASSWORD);
  assert.ok(result.ok, `signup of ${email}`);
  return result.session;
}

before(async () => {
  stack = await startStack(new FixedBalanceAdapter("ethereum", {}));
});

after(async () => {
  await stack.close();
});

beforeEach(() => {
  consoleErrors.length = 0;
  window.localStorage.clear();
});
afterEach(cleanup);

test("a stored session with a live token is restored through the real /accounts/me", async () => {
  // The control for the expiry test below: the same kind of token, stored with a future expiry.
  const session = await signup("live@example.com");
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  assert.equal(await restored(await freshSession()), "signed-in as live@example.com");
  assert.deepEqual(consoleErrors, []);
});

test("a stored session whose expiresAt has passed is not signed in, even though the server would still accept its token", async () => {
  const session = await signup("expired-locally@example.com");
  // Still valid server-side, so anything but "anonymous" here would mean the stale copy was used.
  assert.ok((await stack.accountService.authenticate(session.token)).ok);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: session.token, expiresAt: PAST }));

  assert.equal(await restored(await freshSession()), "anonymous");
  assert.equal(window.localStorage.getItem(STORAGE_KEY), null, "the expired copy is dropped from storage");
  assert.deepEqual(consoleErrors, []);
});

test("malformed JSON under the session key is recovered from: not signed in, and the junk is cleared", async () => {
  window.localStorage.setItem(STORAGE_KEY, "{not json");
  assert.equal(await restored(await freshSession()), "anonymous");
  assert.equal(window.localStorage.getItem(STORAGE_KEY), null);
  assert.deepEqual(consoleErrors, []);
});

test("a stored object with no string token is treated the same as no session", async () => {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: 42, expiresAt: FUTURE }));
  assert.equal(await restored(await freshSession()), "anonymous");
  assert.equal(window.localStorage.getItem(STORAGE_KEY), null);
  assert.deepEqual(consoleErrors, []);
});

test("a 401 from /accounts/me (session revoked server-side) clears the stored session: anonymous", async () => {
  const session = await signup("revoked@example.com");
  await stack.accountService.logout(session.token);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));

  assert.equal(await restored(await freshSession()), "anonymous");
  assert.equal(window.localStorage.getItem(STORAGE_KEY), null, "a refused token is forgotten");
  assert.deepEqual(consoleErrors, []);
});

test("a 500 from /accounts/me is 'unreachable', not 'anonymous': the token is kept for when the API recovers", async () => {
  // A real accounts server whose accounts file is corrupt: authenticate() throws, and the
  // handler's catch-all answers 500 { error: "internal" }.
  const dir = await mkdtemp(join(tmpdir(), "osstrace-web-session-"));
  const accountsPath = join(dir, "accounts.json");
  await writeFile(accountsPath, JSON.stringify({ version: 99 }));
  const handler = createAccountsHandler(new AccountService(new JsonFileAccountStore(accountsPath)), { allowedOrigins: [WEB_ORIGIN] });
  const broken: Running = await listen(async (req, res) => void (await handler(req, res)));
  try {
    const session = await signup("broken-server@example.com");
    const stored = JSON.stringify(session);
    window.localStorage.setItem(STORAGE_KEY, stored);

    assert.equal(await restored(await freshSession(broken.url)), "unreachable: internal error");
    assert.equal(window.localStorage.getItem(STORAGE_KEY), stored, "the token is not thrown away over a server error");
    // The only console.error is the accounts server's own log of the failure, not the UI's.
    assert.ok(consoleErrors.length > 0 && consoleErrors.every((line) => line.startsWith("accounts: unhandled error")), consoleErrors.join("\n"));
  } finally {
    await broken.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("no accounts API at all (connection refused) is 'unreachable' with the URL it tried, token kept", async () => {
  // A port that was just listening and is now closed: nothing answers there.
  const gone = await listen((_req, res) => void res.end());
  await gone.close();
  const session = await signup("offline@example.com");
  const stored = JSON.stringify(session);
  window.localStorage.setItem(STORAGE_KEY, stored);

  assert.equal(await restored(await freshSession(gone.url)), `unreachable: can't reach the accounts API at ${gone.url}`);
  assert.equal(window.localStorage.getItem(STORAGE_KEY), stored);
  assert.deepEqual(consoleErrors, []);
});

test("localStorage.setItem throwing (Safari private browsing) doesn't break sign-in: signed in for this page, nothing persisted", async () => {
  const original = Object.getOwnPropertyDescriptor(window, "localStorage");
  const real = window.localStorage;
  const writes: string[] = [];
  // A stand-in Storage that reads and removes like the real one but refuses every write, the way
  // Safari's private mode did: setItem throws QuotaExceededError.
  const refusing = {
    getItem: (key: string) => real.getItem(key),
    removeItem: (key: string) => real.removeItem(key),
    clear: () => real.clear(),
    key: (index: number) => real.key(index),
    get length() {
      return real.length;
    },
    setItem(key: string) {
      writes.push(key);
      throw new window.DOMException("The quota has been exceeded.", "QuotaExceededError");
    },
  };
  Object.defineProperty(window, "localStorage", { configurable: true, get: () => refusing });
  try {
    const session = await freshSession();
    assert.equal(await restored(session), "anonymous");

    const error = await during(session.signIn("signup", "private-mode@example.com", PASSWORD));
    assert.equal(error, null, "sign-up itself succeeds");
    await waitFor(() => text().includes("signed-in as private-mode@example.com"), "the signed-in state");
    assert.deepEqual(writes, [STORAGE_KEY], "it did try to persist the session");
    assert.equal(real.getItem(STORAGE_KEY), null, "and nothing was stored");

    // Signing out (a removeItem) still works from here.
    await during(session.signOut());
    await waitFor(() => text().trim() === "anonymous", "the signed-out state");
  } finally {
    if (original) Object.defineProperty(window, "localStorage", original);
    else delete (window as unknown as Record<string, unknown>)["localStorage"];
  }
  assert.equal(window.localStorage, real, "the real localStorage is back for the next test");
  assert.deepEqual(consoleErrors, []);
});
