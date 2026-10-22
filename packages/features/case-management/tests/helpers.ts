import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountService, createAccountsHandler, JsonFileAccountStore, type PublicUser, type Role } from "@osstrace/accounts";
import { createCasesHandler } from "../src/http.ts";
import { CaseService } from "../src/service.ts";
import { JsonFileCaseStore } from "../src/store.ts";

export const GOOD_PASSWORD = "correct horse battery staple";
export const WEB_ORIGIN = "http://localhost:5301";

// Real, well-formed, well-known public mainnet addresses used only as inputs (the Ethereum
// beacon-chain deposit contract, the Ethereum Foundation's donation address, and Solana's SPL
// Token Program id) — the same ones @osstrace/private-labels' tests use. The tests never claim
// anything about them; they're just valid addresses.
export const ETH_ADDR = "0x00000000219ab540356cbb839cbe05303d7705fa";
export const ETH_ADDR_CHECKSUMMED = "0x00000000219ab540356cBB839Cbe05303d7705Fa";
export const ETH_ADDR_2 = "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae";
export const SOL_ADDR = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** A clock tests can move forward, passed into the real services via their `now` option. */
export class TestClock {
  #ms: number;
  constructor(iso = "2026-10-22T12:00:00.000Z") {
    this.#ms = Date.parse(iso);
  }
  now = (): Date => new Date(this.#ms);
  advance(ms: number): void {
    this.#ms += ms;
  }
}

export interface StoreLimits {
  casesPerUserLimit?: number;
  itemsPerCaseLimit?: number;
}

export interface Stack {
  dir: string;
  accounts: AccountService;
  store: JsonFileCaseStore;
  service: CaseService;
  casesPath: string;
  clock: TestClock;
  /** Real signup (real argon2), optionally promoted by the operator path -- exactly as in production. */
  account(email: string, role?: Role): Promise<{ user: PublicUser; token: string }>;
}

/** The real accounts service + the real case service over real temp files, removed afterwards — no mocks. */
export async function withStack(run: (stack: Stack) => Promise<void>, limits: StoreLimits = {}): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "osstrace-cases-test-"));
  try {
    const clock = new TestClock();
    const accounts = new AccountService(new JsonFileAccountStore(join(dir, "accounts.json"), { now: clock.now }), { now: clock.now });
    const casesPath = join(dir, "cases.json");
    const store = new JsonFileCaseStore(casesPath, limits);
    const service = new CaseService(accounts, store, { now: clock.now });
    await run({
      dir,
      accounts,
      store,
      service,
      casesPath,
      clock,
      async account(email, role) {
        const signup = await accounts.signup(email, GOOD_PASSWORD);
        if (!signup.ok) throw new Error(`signup failed: ${signup.message}`);
        let user = signup.user;
        if (role && role !== "user") {
          const promoted = await accounts.setRoleAsOperator(email, role);
          if (!promoted.ok) throw new Error(`promotion failed: ${promoted.message}`);
          user = promoted.user;
        }
        return { user, token: signup.session.token };
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * One real HTTP server on an ephemeral port mounting BOTH the real accounts routes and the real
 * case routes — exactly how a browser sees them, called with real `fetch`.
 */
export async function withServer(run: (base: string, stack: Stack) => Promise<void>, limits: StoreLimits = {}): Promise<void> {
  await withStack(async (stack) => {
    const accountsHandle = createAccountsHandler(stack.accounts, { allowedOrigins: [WEB_ORIGIN] });
    const casesHandle = createCasesHandler(stack.service, { allowedOrigins: [WEB_ORIGIN] });
    const server: Server = createServer(async (req, res) => {
      if (await accountsHandle(req, res)) return;
      if (await casesHandle(req, res)) return;
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
  }, limits);
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
