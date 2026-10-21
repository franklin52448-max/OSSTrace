import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh temp dir with an accounts-file path inside it, removed afterwards — real files, no mocks. */
export async function withTempAccountsFile(run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "opentrace-accounts-test-"));
  try {
    await run(join(dir, "accounts.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A clock tests can move forward, passed into the real service/store via their `now` option. */
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

export const GOOD_PASSWORD = "correct horse battery staple";
