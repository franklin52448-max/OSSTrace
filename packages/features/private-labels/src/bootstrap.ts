import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountService, JsonFileAccountStore } from "@opentrace/accounts";
import { PrivateLabelService } from "./service.ts";
import { JsonFilePrivateLabelStore } from "./store.ts";

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

function fromRepoRoot(configured: string | undefined, fallback: string): string {
  if (configured) return isAbsolute(configured) ? configured : resolve(REPO_ROOT, configured);
  return resolve(REPO_ROOT, fallback);
}

/**
 * `PRIVATE_LABELS_STORE_PATH` if set (relative paths resolve from the repo root), else
 * `data/private/private-labels.json` — git-ignored, next to the accounts file.
 */
export function privateLabelsStorePath(): string {
  return fromRepoRoot(process.env["PRIVATE_LABELS_STORE_PATH"], "data/private/private-labels.json");
}

/**
 * The accounts file to authenticate sessions against. Must be the same file the accounts API
 * writes, so it honours the same `ACCOUNTS_STORE_PATH` variable with the same default as
 * `packages/features/accounts/src/bootstrap.ts`. (That resolver isn't part of
 * `@opentrace/accounts`' public API, so it's mirrored here rather than imported from its source.)
 * This server only ever *reads* the accounts file — `authenticate()` never writes — so running it
 * next to the accounts server doesn't break that store's one-writer assumption.
 */
export function accountsStorePath(): string {
  return fromRepoRoot(process.env["ACCOUNTS_STORE_PATH"], "data/private/accounts.json");
}

export function buildPrivateLabelService(): PrivateLabelService {
  const accounts = new AccountService(new JsonFileAccountStore(accountsStorePath()));
  return new PrivateLabelService(accounts, new JsonFilePrivateLabelStore(privateLabelsStorePath()));
}

export function allowedOriginsFromEnv(): string[] {
  const raw = process.env["PRIVATE_LABELS_ALLOWED_ORIGINS"] ?? process.env["ACCOUNTS_ALLOWED_ORIGINS"];
  if (!raw) return ["http://localhost:5301"];
  return raw.split(",").map((o) => o.trim()).filter(Boolean);
}
