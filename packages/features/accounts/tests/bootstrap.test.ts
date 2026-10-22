import { test } from "node:test";
import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { accountsStorePath, allowedOriginsFromEnv } from "../src/bootstrap.ts";

/**
 * Saves and restores exactly the env vars a test touches, so tests can run in any order without
 * leaking state into each other — these functions read `process.env` directly, so there's no way
 * to inject a fake environment short of mutating it for the duration of one test.
 */
async function withEnv(vars: Record<string, string | undefined>, run: () => void | Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) previous.set(key, process.env[key]);
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("accountsStorePath: with no ACCOUNTS_STORE_PATH, resolves the real default under the repo root", async () => {
  await withEnv({ ACCOUNTS_STORE_PATH: undefined }, () => {
    const path = accountsStorePath();
    assert.ok(isAbsolute(path), "always an absolute path, so it doesn't depend on the caller's cwd");
    assert.ok(path.endsWith("/data/private/accounts.json"), path);
  });
});

test("accountsStorePath: a relative ACCOUNTS_STORE_PATH resolves from the repo root, not the caller's cwd", async () => {
  await withEnv({ ACCOUNTS_STORE_PATH: "data/private/custom-accounts.json" }, () => {
    const path = accountsStorePath();
    assert.ok(isAbsolute(path));
    assert.ok(path.endsWith("/data/private/custom-accounts.json"), path);
    assert.ok(!path.includes("packages/features/accounts"), "must resolve from the repo root, not this package's own folder");
  });
});

test("accountsStorePath: an absolute ACCOUNTS_STORE_PATH passes through unchanged", async () => {
  await withEnv({ ACCOUNTS_STORE_PATH: "/tmp/somewhere/accounts.json" }, () => {
    assert.equal(accountsStorePath(), "/tmp/somewhere/accounts.json");
  });
});

test("allowedOriginsFromEnv: with no ACCOUNTS_ALLOWED_ORIGINS, defaults to the web dev origin", async () => {
  await withEnv({ ACCOUNTS_ALLOWED_ORIGINS: undefined }, () => {
    assert.deepEqual(allowedOriginsFromEnv(), ["http://localhost:5301"]);
  });
});

test("allowedOriginsFromEnv: an empty-string value counts as unset, not an empty allowlist", async () => {
  await withEnv({ ACCOUNTS_ALLOWED_ORIGINS: "" }, () => {
    assert.deepEqual(allowedOriginsFromEnv(), ["http://localhost:5301"]);
  });
});

test("allowedOriginsFromEnv: a comma-separated list is trimmed, with blank entries dropped", async () => {
  await withEnv({ ACCOUNTS_ALLOWED_ORIGINS: " http://a.example , http://b.example ,,  " }, () => {
    assert.deepEqual(allowedOriginsFromEnv(), ["http://a.example", "http://b.example"]);
  });
});
