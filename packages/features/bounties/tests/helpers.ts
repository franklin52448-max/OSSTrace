import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountService, JsonFileAccountStore, type PublicUser, type Role } from "@osstrace/accounts";
import type { DepositVerification, DepositVerifier } from "../src/deposits.ts";
import { BountyService } from "../src/service.ts";
import { JsonFileBountyStore } from "../src/store.ts";

export const GOOD_PASSWORD = "correct horse battery staple";

/**
 * A real, concrete `DepositVerifier` a test fully controls — not a mocking framework. Each test
 * decides in advance exactly what `verify()` should answer for a given `(chain, txRef)`, the same
 * way `FixedBalanceAdapter` elsewhere in this repo stands in for a real chain adapter. The real
 * on-chain checking logic itself (`verifySolanaDeposit`/`verifyEthereumDeposit`) has its own real
 * tests, against real recorded mainnet data, in `deposits.test.ts` -- this stand-in is only for
 * testing `recordDeposit`'s own auth/validation/idempotency logic in isolation from the network.
 */
export class FixedDepositVerifier implements DepositVerifier {
  readonly #answers = new Map<string, DepositVerification>();
  readonly calls: { chain: "ethereum" | "solana"; txRef: string }[] = [];

  set(chain: "ethereum" | "solana", txRef: string, result: DepositVerification): void {
    this.#answers.set(`${chain}:${txRef}`, result);
  }

  async verify(chain: "ethereum" | "solana", txRef: string): Promise<DepositVerification> {
    this.calls.push({ chain, txRef });
    return this.#answers.get(`${chain}:${txRef}`) ?? { ok: false, reason: "not_found" };
  }
}

/** A clock tests can move forward, passed into the real service via its `now` option. */
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

export interface Env {
  dir: string;
  accounts: AccountService;
  store: JsonFileBountyStore;
  service: BountyService;
  clock: TestClock;
  deposits: FixedDepositVerifier;
  /** Real signup (real argon2), optionally promoted by the operator path -- exactly as in production. */
  account(email: string, role?: Role): Promise<{ user: PublicUser; token: string }>;
}

/** Real temp files for both the accounts store and the bounties store, removed afterwards. */
export async function withEnv(run: (env: Env) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "osstrace-bounties-test-"));
  try {
    const clock = new TestClock();
    const accounts = new AccountService(new JsonFileAccountStore(join(dir, "accounts.json")));
    const store = new JsonFileBountyStore(join(dir, "bounties.json"));
    const deposits = new FixedDepositVerifier();
    const service = new BountyService(store, accounts, { now: clock.now, deposits });
    await run({
      dir,
      accounts,
      store,
      service,
      clock,
      deposits,
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

export function validBountyBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Natural-language Tracer agent",
    description:
      "An agent that answers plain-language on-chain questions (\"did wallet A send wallet B more than $100 of USDC in the last 30 days?\") by actually calling Tracer's tracePath, not by guessing. ".repeat(2),
    reward: "100,000 tokens (token TBD)",
    ...overrides,
  };
}

export function validSubmissionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prUrl: "https://github.com/OpenTraceIntelligence/OSSTrace/pull/42",
    note: "Implements it against /trace/path directly.",
    ...overrides,
  };
}
