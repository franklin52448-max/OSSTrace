import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Wallet } from "ethers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ComponentType } from "react";
import { window } from "./harness/env.ts";
import { cleanup, click, consoleErrors, getAllByRole, getByAriaLabel, getButton, render, text, type, waitFor } from "./harness/render.ts";
import { startNewServer, type RunningNewServer } from "./harness/newServer.ts";

// The wallet connect / settings menu against a real, booted @osstrace/server instance (ADR 0022)
// -- real challenge/verify, real cookie session. The injected `window.solana` below is a fake
// Phantom-shaped provider (real ed25519 keys, real signatures); nothing about the server side is
// faked.
//
// One real browser behaviour Node's bare `fetch` doesn't replicate: a page always sends its own
// Origin on a cross-origin request, unforgeable by page script -- that's the whole CSRF defence
// app.ts's Origin allowlist relies on. serverApiCall (serverSession.ts) never sets it itself (a
// real page can't either), so it's patched in here for the life of this file, exactly mirroring
// what a real browser at WEB_ORIGIN would send automatically.

const WEB_ORIGIN = "http://localhost:5301"; // matches env.ts's WEB_ORIGIN; must be in the server's allowedOrigins

// Same reason: a browser's cookie jar resends a Set-Cookie on every later request to that origin;
// Node's fetch has none at all, so a session established by one request (verify) is invisible to
// the next (a later settings PATCH) unless this test file replicates that one piece of jar
// behaviour too. One cookie is all a test here ever needs, so a single string is enough.
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

let server: RunningNewServer;
let AccountPanel: ComponentType;
let serverSignOut: () => Promise<void>;
let queryClient: QueryClient;

function solanaKeypair(seed: string): { address: string; secretKey: Uint8Array } {
  const kp = nacl.sign.keyPair.fromSeed(createHash("sha256").update(seed).digest());
  return { address: bs58.encode(Buffer.from(kp.publicKey)), secretKey: kp.secretKey };
}

/** A fake Phantom-shaped provider: connects to a fixed address, signs with a real ed25519 key. */
function mockPhantom(seed: string) {
  const { address, secretKey } = solanaKeypair(seed);
  return {
    async connect() {
      return { publicKey: { toString: () => address } };
    },
    async signMessage(message: Uint8Array) {
      return { signature: nacl.sign.detached(message, secretKey) };
    },
  };
}

/** A fake MetaMask-shaped (EIP-1193) provider: a real secp256k1 wallet signs via real `personal_sign` semantics (ethers). */
function mockMetaMask(seed: string) {
  const wallet = new Wallet(createHash("sha256").update(seed).digest("hex"));
  return {
    address: wallet.address,
    async request({ method, params }: { method: string; params?: unknown[] }) {
      if (method === "eth_requestAccounts") return [wallet.address];
      if (method === "personal_sign") return wallet.signMessage(params?.[0] as string);
      throw new Error(`mockMetaMask: unexpected method ${method}`);
    },
  };
}

before(async () => {
  server = await startNewServer([WEB_ORIGIN]);
  process.env["VITE_SERVER_URL"] = server.url;
  ({ default: AccountPanel } = await import("../src/AccountPanel.tsx"));
  ({ serverSignOut } = await import("../src/serverSession.ts"));
});

after(async () => {
  delete process.env["VITE_SERVER_URL"];
  await server.close();
});

beforeEach(async () => {
  await serverSignOut(); // the session store is a module-level singleton -- reset it between tests
  jarCookie = "";
  consoleErrors.length = 0;
  queryClient = new QueryClient();
  delete (window as unknown as { solana?: unknown }).solana;
  delete (window as unknown as { ethereum?: unknown }).ethereum;
});
afterEach(cleanup);

async function renderPanel() {
  return render(createElement(QueryClientProvider, { client: queryClient }, createElement(AccountPanel)));
}

/** Opens the header account menu's connect-wallet form (the header's own "Connect wallet" trigger, not yet inside any menu). */
async function openConnectMenu(): Promise<HTMLElement> {
  await renderPanel();
  await click(await waitFor(() => (text().includes("Connect wallet") ? getButton("Connect wallet") : null), "the logged-out 'Connect wallet' trigger"));
  return waitFor(() => window.document.querySelector('[aria-label="Connect wallet"]') as HTMLElement | null, "the connect-wallet menu");
}

/** The menu's one live region: exactly one, so a message can only ever land in it. */
function alertRegion(root: HTMLElement): HTMLElement {
  const alerts = getAllByRole("alert", root);
  assert.equal(alerts.length, 1);
  return alerts[0] as HTMLElement;
}

/** The signed-in header's own toggle button: its accessible name is the wallet's handle, so an
 *  exact-text match (getButton) won't do -- found by substring instead, the same way a person
 *  skimming the page would spot it. */
function getHeaderToggle(handle: string): HTMLElement {
  const match = [...window.document.querySelectorAll("button")].find((b) => text(b).includes(handle));
  if (!match) throw new Error(`no signed-in header trigger showing "${handle}"`);
  return match;
}

test("the connect menu offers Phantom and MetaMask, with an Install link when a provider isn't detected", async () => {
  const menu = await openConnectMenu();
  assert.ok(text(menu).includes("Phantom"));
  assert.ok(text(menu).includes("MetaMask"));
  // Neither window.solana nor window.ethereum is installed in this test by default.
  assert.ok(menu.querySelectorAll("a").length >= 2, "both options render as Install links");
  assert.deepEqual(consoleErrors, []);
});

test("connecting Phantom runs the real challenge/verify flow and shows the signed-in wallet in the header", async () => {
  (window as unknown as { solana: unknown }).solana = mockPhantom("accountpaneltest");
  const menu = await openConnectMenu();
  await click(getButton("Phantom", menu));
  await waitFor(() => text().includes("sol_"), "the signed-in handle"); // shortHandle() always starts with sol_
  assert.deepEqual(consoleErrors, []);
});

test("a signature failure puts the real error into the alert region that was already there", async () => {
  (window as unknown as { solana: unknown }).solana = {
    async connect() {
      return { publicKey: { toString: () => solanaKeypair("rejecter").address } };
    },
    async signMessage(): Promise<never> {
      throw new Error("User rejected the request");
    },
  };
  const menu = await openConnectMenu();
  const region = alertRegion(menu);
  assert.equal(text(region).trim(), "");

  await click(getButton("Phantom", menu));

  await waitFor(() => text(region).includes("User rejected the request"), "the signature-rejection error");
  assert.equal(alertRegion(menu), region, "the same region received the message");
  assert.deepEqual(consoleErrors, []);
});

test("Settings: changing the display name persists through the real server and updates the header", async () => {
  (window as unknown as { solana: unknown }).solana = mockPhantom("settingstest");
  const menu = await openConnectMenu();
  await click(getButton("Phantom", menu));
  await waitFor(() => text().includes("sol_"), "the signed-in handle");

  await click(getHeaderToggle("sol_"));
  await click(getButton("Settings"));
  await type(getByAriaLabel("Display name"), "Racer");
  await click(getButton("Save"));

  await waitFor(() => text().includes("Racer"), "the new display name in the header");
  assert.deepEqual(consoleErrors, []);
});

test("connecting MetaMask runs the real challenge/verify flow with a real secp256k1 signature and shows the signed-in wallet", async () => {
  const mm = mockMetaMask("metamasktest");
  (window as unknown as { ethereum: unknown }).ethereum = mm;
  const menu = await openConnectMenu();
  await click(getButton("MetaMask", menu));
  await waitFor(() => text().includes("eth_"), "the signed-in handle"); // shortHandle() always starts with eth_
  assert.deepEqual(consoleErrors, []);
});

test("an Ethereum provider returning no accounts puts the real error into the alert region", async () => {
  (window as unknown as { ethereum: unknown }).ethereum = {
    async request({ method }: { method: string }) {
      if (method === "eth_requestAccounts") return [];
      throw new Error("unexpected method");
    },
  };
  const menu = await openConnectMenu();
  const region = alertRegion(menu);
  await click(getButton("MetaMask", menu));
  await waitFor(() => text(region).includes("the wallet returned no account"), "the no-account error");
  assert.deepEqual(consoleErrors, []);
});

test("a Solana wallet without signMessage support puts the real error into the alert region", async () => {
  const { address } = solanaKeypair("nosignmessage");
  (window as unknown as { solana: unknown }).solana = {
    async connect() {
      return { publicKey: { toString: () => address } };
    },
    // signMessage deliberately omitted -- some Solana-injected providers don't implement it.
  };
  const menu = await openConnectMenu();
  const region = alertRegion(menu);
  await click(getButton("Phantom", menu));
  await waitFor(() => text(region).includes("this wallet doesn't support message signing"), "the unsupported-signMessage error");
  assert.deepEqual(consoleErrors, []);
});
