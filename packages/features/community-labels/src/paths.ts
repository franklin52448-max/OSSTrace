import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * `COMMUNITY_LABELS_PATH` if set (relative paths resolve from the repo root), else
 * `data/community/submissions.json` (git-ignored: it's this instance's runtime data, not seed data
 * for the repo). The server that writes it and the Explorer/Visualizer that read it must agree, so
 * they all call this.
 */
export function communityLabelsPath(): string {
  const configured = process.env["COMMUNITY_LABELS_PATH"];
  if (configured) return isAbsolute(configured) ? configured : resolve(REPO_ROOT, configured);
  return resolve(REPO_ROOT, "data/community/submissions.json");
}
