import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountService, JsonFileAccountStore, type PublicUser, type Role } from "@opentrace/accounts";
import { LabelSubmissionService } from "../src/service.ts";
import { JsonFileSubmissionStore } from "../src/store.ts";

export const GOOD_PASSWORD = "correct horse battery staple";

/**
 * The Safe v1.4.1 contract, checksummed — a real address also in this repo's ingested Safe
 * dataset (data/labels/safe-deployments.json), so the fixture label below is a true, sourced claim.
 */
export const ETH_ADDRESS = "0x41675C099F32341bf84BFc5382aF534df5C7461a";
/** A syntactically valid Solana address (base58, 44 chars), used only for format validation. */
export const SOL_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/** A clock tests can move forward, passed into the real service via its `now` option. */
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

export interface Env {
  dir: string;
  accounts: AccountService;
  store: JsonFileSubmissionStore;
  submissionsPath: string;
  service: LabelSubmissionService;
  clock: TestClock;
  /** Real signup (real argon2), optionally promoted by the operator path — exactly as in production. */
  account(email: string, role?: Role): Promise<{ user: PublicUser; token: string }>;
}

/** Real temp files for both the accounts store and the submissions store, removed afterwards. */
export async function withEnv(run: (env: Env) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "opentrace-community-labels-test-"));
  try {
    const clock = new TestClock();
    const accounts = new AccountService(new JsonFileAccountStore(join(dir, "accounts.json")));
    const submissionsPath = join(dir, "submissions.json");
    const store = new JsonFileSubmissionStore(submissionsPath);
    const service = new LabelSubmissionService(store, accounts, { now: clock.now });
    await run({
      dir,
      accounts,
      store,
      submissionsPath,
      service,
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

export function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chain: "ethereum",
    address: ETH_ADDRESS,
    name: "Safe: Safe v1.4.1",
    confidence: "verified",
    source: {
      url: "https://github.com/safe-global/safe-deployments/blob/main/src/assets/v1.4.1/safe.json",
      description: "Safe's official deployments registry lists this as the Safe v1.4.1 contract on Ethereum mainnet",
    },
    ...overrides,
  };
}
