import { test } from "node:test";
import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { accountsStorePath, allowedOriginsFromEnv, privateLabelsStorePath } from "../src/bootstrap.ts";

/** Saves and restores exactly the env vars a test touches — see accounts/tests/bootstrap.test.ts for why. */
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

test("privateLabelsStorePath: with no PRIVATE_LABELS_STORE_PATH, resolves the real default under the repo root", async () => {
  await withEnv({ PRIVATE_LABELS_STORE_PATH: undefined }, () => {
    const path = privateLabelsStorePath();
    assert.ok(isAbsolute(path), "always an absolute path, so it doesn't depend on the caller's cwd");
    assert.ok(path.endsWith("/data/private/private-labels.json"), path);
  });
});

test("privateLabelsStorePath: a relative PRIVATE_LABELS_STORE_PATH resolves from the repo root", async () => {
  await withEnv({ PRIVATE_LABELS_STORE_PATH: "data/private/custom.json" }, () => {
    const path = privateLabelsStorePath();
    assert.ok(isAbsolute(path));
    assert.ok(path.endsWith("/data/private/custom.json"), path);
  });
});

test("privateLabelsStorePath: an absolute PRIVATE_LABELS_STORE_PATH passes through unchanged", async () => {
  await withEnv({ PRIVATE_LABELS_STORE_PATH: "/tmp/somewhere/private-labels.json" }, () => {
    assert.equal(privateLabelsStorePath(), "/tmp/somewhere/private-labels.json");
  });
});

// This mirrors @osstrace/accounts' own accountsStorePath() (same env var, same default) so this
// server reads the exact same accounts file the accounts API writes — see this package's own
// bootstrap.ts for why it's a mirror rather than an import. Since this session's community-labels
// "share" feature now reads this exact path resolver cross-package too, a drift bug here would
// silently break both callers with no test to catch it.
test("accountsStorePath mirrors @osstrace/accounts': same env var, same default, same resolution rules", async () => {
  await withEnv({ ACCOUNTS_STORE_PATH: undefined }, () => {
    assert.ok(accountsStorePath().endsWith("/data/private/accounts.json"));
  });
  await withEnv({ ACCOUNTS_STORE_PATH: "data/private/custom-accounts.json" }, () => {
    const path = accountsStorePath();
    assert.ok(isAbsolute(path));
    assert.ok(path.endsWith("/data/private/custom-accounts.json"), path);
  });
  await withEnv({ ACCOUNTS_STORE_PATH: "/tmp/somewhere/accounts.json" }, () => {
    assert.equal(accountsStorePath(), "/tmp/somewhere/accounts.json");
  });
});

test("allowedOriginsFromEnv: falls back to ACCOUNTS_ALLOWED_ORIGINS, then the web dev origin default", async () => {
  await withEnv({ PRIVATE_LABELS_ALLOWED_ORIGINS: undefined, ACCOUNTS_ALLOWED_ORIGINS: undefined }, () => {
    assert.deepEqual(allowedOriginsFromEnv(), ["http://localhost:5301"]);
  });
  await withEnv({ PRIVATE_LABELS_ALLOWED_ORIGINS: undefined, ACCOUNTS_ALLOWED_ORIGINS: "http://shared.example" }, () => {
    assert.deepEqual(allowedOriginsFromEnv(), ["http://shared.example"]);
  });
  await withEnv({ PRIVATE_LABELS_ALLOWED_ORIGINS: "http://own.example", ACCOUNTS_ALLOWED_ORIGINS: "http://shared.example" }, () => {
    assert.deepEqual(allowedOriginsFromEnv(), ["http://own.example"], "this package's own var wins over the shared fallback");
  });
});
