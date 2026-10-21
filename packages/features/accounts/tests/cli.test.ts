import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AccountService } from "../src/service.ts";
import { JsonFileAccountStore } from "../src/store.ts";
import { GOOD_PASSWORD, withTempAccountsFile } from "./helpers.ts";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function cli(storePath: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], {
      env: { ...process.env, ACCOUNTS_STORE_PATH: storePath },
    });
    return { code: 0, stdout, stderr };
  } catch (cause) {
    const e = cause as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

test("the operator CLI, as a real separate process, promotes an existing account and a running service sees it", async () => {
  await withTempAccountsFile(async (path) => {
    const service = new AccountService(new JsonFileAccountStore(path));
    const signed = await service.signup("operator@example.com", GOOD_PASSWORD);
    assert.ok(signed.ok);

    const result = await cli(path, "Operator@Example.com", "admin");
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /operator@example\.com .* is now "admin"/);

    // Same service instance, same session token, no restart — the new role is live.
    assert.ok((await service.requireRole(signed.session.token, "admin")).ok);
  });
});

test("the operator CLI fails cleanly for an unknown email, a bad role, or missing args", async () => {
  await withTempAccountsFile(async (path) => {
    const unknown = await cli(path, "ghost@example.com", "admin");
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /not_found/);

    await new AccountService(new JsonFileAccountStore(path)).signup("a@example.com", GOOD_PASSWORD);
    const badRole = await cli(path, "a@example.com", "superuser");
    assert.equal(badRole.code, 1);
    assert.match(badRole.stderr, /invalid_role/);

    assert.equal((await cli(path)).code, 2);
  });
});
