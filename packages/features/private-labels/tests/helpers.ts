import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountService, createAccountsHandler, JsonFileAccountStore } from "@opentrace/accounts";
import { createPrivateLabelsHandler } from "../src/http.ts";
import { PrivateLabelService } from "../src/service.ts";
import { JsonFilePrivateLabelStore } from "../src/store.ts";

export const GOOD_PASSWORD = "correct horse battery staple";
export const WEB_ORIGIN = "http://localhost:5301";

// Real, well-formed, well-known public mainnet addresses used only as inputs (the Ethereum
// beacon-chain deposit contract, the Ethereum Foundation's donation address, and Solana's SPL
// Token Program id). The tests never claim anything about them — they're just valid addresses.
export const ETH_ADDR = "0x00000000219ab540356cbb839cbe05303d7705fa";
export const ETH_ADDR_2 = "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae";
export const SOL_ADDR = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** A fresh temp dir holding both real store files, removed afterwards — no mocks. */
export async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "opentrace-private-labels-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A clock tests can move forward, passed into the real services via their `now` option. */
export class TestClock {
  #ms: number;
  constructor(iso = "2026-10-21T12:00:00.000Z") {
    this.#ms = Date.parse(iso);
  }
  now = (): Date => new Date(this.#ms);
  advance(ms: number): void {
    this.#ms += ms;
  }
}

export interface Stack {
  dir: string;
  accounts: AccountService;
  service: PrivateLabelService;
  labelsPath: string;
  clock: TestClock;
}

/** The real accounts service + real private-label service over real temp files. */
export async function withStack(run: (stack: Stack) => Promise<void>, options: { perUserLimit?: number } = {}): Promise<void> {
  await withTempDir(async (dir) => {
    const clock = new TestClock();
    const accounts = new AccountService(new JsonFileAccountStore(join(dir, "accounts.json"), { now: clock.now }), { now: clock.now });
    const labelsPath = join(dir, "private-labels.json");
    const store = new JsonFilePrivateLabelStore(labelsPath, options);
    const service = new PrivateLabelService(accounts, store, { now: clock.now });
    await run({ dir, accounts, service, labelsPath, clock });
  });
}

/**
 * One real HTTP server on an ephemeral port mounting BOTH the real accounts routes and the real
 * private-label routes — exactly how a browser sees them, called with real `fetch`.
 */
export async function withServer(run: (base: string, stack: Stack) => Promise<void>, options: { perUserLimit?: number } = {}): Promise<void> {
  await withStack(async (stack) => {
    const accountsHandle = createAccountsHandler(stack.accounts, { allowedOrigins: [WEB_ORIGIN] });
    const labelsHandle = createPrivateLabelsHandler(stack.service, { allowedOrigins: [WEB_ORIGIN] });
    const server: Server = createServer(async (req, res) => {
      if (await accountsHandle(req, res)) return;
      if (await labelsHandle(req, res)) return;
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${port}`, stack);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, options);
}

export interface CallResult {
  status: number;
  body: any;
  text: string;
  headers: Headers;
}

export async function call(
  base: string,
  method: string,
  path: string,
  options: { body?: unknown; rawBody?: string; token?: string; origin?: string; headers?: Record<string, string> } = {},
): Promise<CallResult> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined || options.rawBody !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers["authorization"] = `Bearer ${options.token}`;
  if (options.origin) headers["origin"] = options.origin;
  const res = await fetch(base + path, {
    method,
    headers,
    body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text, headers: res.headers };
}

/** Signs up a real account over HTTP; returns its id and session token. */
export async function signup(base: string, email: string): Promise<{ id: string; token: string }> {
  const res = await call(base, "POST", "/accounts/signup", { body: { email, password: GOOD_PASSWORD } });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${res.text}`);
  return { id: res.body.user.id as string, token: res.body.session.token as string };
}
