import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * `BOUNTIES_PATH` if set (relative paths resolve from the repo root), else
 * `data/bounties/bounties.json` (git-ignored: runtime data, not repo seed data). The server that
 * writes it and anything else that might read it must agree, so they all call this.
 */
export function bountiesPath(): string {
  const configured = process.env["BOUNTIES_PATH"];
  if (configured) return isAbsolute(configured) ? configured : resolve(REPO_ROOT, configured);
  return resolve(REPO_ROOT, "data/bounties/bounties.json");
}
