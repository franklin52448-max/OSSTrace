/**
 * One-time migration aid: copies the real bounty(ies) posted on the old standalone
 * @osstrace/bounties service's JSON store (data/bounties/bounties.json) into the new unified
 * server's database (packages/server, ADR 0022), now that Bounties has been ported onto it.
 *
 * The old service identified a bounty's opener/claimant/resolver by an @osstrace/accounts user id
 * (email+password account). Accounts are wallet-based now (chain, walletAddress) -- there is no
 * real mapping from an old account id to a new wallet identity, and inventing one would misattribute
 * a real person's bounty to a wallet they never signed with. Every migrated bounty is instead
 * attributed to one synthetic "legacy import" system user (chain/wallet_address left NULL, which
 * the unique index allows -- SQLite treats each NULL as distinct), created once and reused.
 *
 * Idempotent: running this again only inserts bounties/submissions whose id isn't already present.
 *
 * Usage: SERVER_DB=/path/to/server.db node --experimental-strip-types scripts/seed-bounties-from-legacy.ts
 * (defaults to the same ./data/server.db path packages/server itself defaults to when unset --
 * see packages/server/src/config.ts). Run once against production's real Fly volume the same way,
 * over `fly ssh console` or an equivalent one-off job, if this hasn't been done there yet.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb } from "../packages/server/src/db/index.ts";

const LEGACY_PATH = fileURLToPath(new URL("../data/bounties/bounties.json", import.meta.url));
const DB_PATH = process.env.SERVER_DB ?? "./data/server.db";
const LEGACY_IMPORT_USERNAME = "legacy-bounty-import";

type LegacyBounty = { id: string; status: "open" | "claimed" | "cancelled"; title: string; description: string; reward: string; openedBy: string; openedAt: string };
type LegacyStore = { version: number; bounties: LegacyBounty[]; submissions: unknown[] };

function nowIso(): string {
  return new Date().toISOString().replace(/(\.\d{3})Z$/, "$1000Z");
}

function main() {
  const legacy = JSON.parse(readFileSync(LEGACY_PATH, "utf8")) as LegacyStore;
  const db = openDb(DB_PATH);

  let systemUserId = db.get<{ id: string }>("SELECT id FROM users WHERE username = ?", LEGACY_IMPORT_USERNAME)?.id;
  if (!systemUserId) {
    systemUserId = randomUUID();
    const now = nowIso();
    db.run("INSERT INTO users (id, username, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", systemUserId, LEGACY_IMPORT_USERNAME, "Legacy bounty import", now, now);
    console.log(`Created system user ${systemUserId} (${LEGACY_IMPORT_USERNAME}) to own migrated bounties.`);
  }

  let inserted = 0;
  let skipped = 0;
  for (const b of legacy.bounties) {
    if (db.get("SELECT 1 FROM bounties WHERE id = ?", b.id)) {
      skipped++;
      continue;
    }
    db.run(
      "INSERT INTO bounties (id, status, title, description, reward, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      b.id,
      b.status,
      b.title,
      b.description,
      b.reward,
      systemUserId,
      b.openedAt,
    );
    inserted++;
  }

  console.log(`Migrated ${inserted} bounty(ies), skipped ${skipped} already present. Legacy submissions in the file: ${legacy.submissions.length} (none to migrate -- the current data has 0).`);
  if (legacy.submissions.length > 0) {
    console.warn("WARNING: legacy submissions exist in the source file but this script does not migrate them -- extend it before relying on this output if that ever changes.");
  }
  db.close();
}

main();
