import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * `CASES_PATH` if set (relative paths resolve from the repo root), else `data/private/cases.json`
 * — git-ignored, next to the accounts and private-labels files, because it's the same kind of
 * per-user private data (ADR 0011).
 */
export function casesPath(): string {
  const configured = process.env["CASES_PATH"];
  if (configured) return isAbsolute(configured) ? configured : resolve(REPO_ROOT, configured);
  return resolve(REPO_ROOT, "data/private/cases.json");
}
