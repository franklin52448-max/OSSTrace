import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountService } from "./service.ts";
import { JsonFileAccountStore } from "./store.ts";

/** Shared setup between the HTTP server and the operator CLI, so they always open the same file. */

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export function loadRootEnv(): void {
  const envPath = resolve(REPO_ROOT, ".env");
  if (existsSync(envPath)) {
    try {
      process.loadEnvFile(envPath);
    } catch {
      // A malformed .env must not crash the process — fall through to defaults.
    }
  }
}

/**
 * `ACCOUNTS_STORE_PATH` if set (relative paths resolve from the repo root), else
 * `data/private/accounts.json`. `data/private/` is git-ignored: this file holds password hashes
 * and emails and must never be committed.
 */
export function accountsStorePath(): string {
  const configured = process.env["ACCOUNTS_STORE_PATH"];
  if (configured) return isAbsolute(configured) ? configured : resolve(REPO_ROOT, configured);
  return resolve(REPO_ROOT, "data/private/accounts.json");
}

export function buildAccountService(): AccountService {
  return new AccountService(new JsonFileAccountStore(accountsStorePath()));
}

export function allowedOriginsFromEnv(): string[] {
  const raw = process.env["ACCOUNTS_ALLOWED_ORIGINS"];
  if (!raw) return ["http://localhost:5301"];
  return raw.split(",").map((o) => o.trim()).filter(Boolean);
}
