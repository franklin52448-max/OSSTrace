import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CompositeLabelStore, InMemoryCache, JsonFileLabelStore, type Cache, type LabelStore } from "@osstrace/core";
import { CommunityLabelReader, communityLabelsPath, JsonFileSubmissionStore } from "@osstrace/community-labels";
import { DEFAULT_ALLOWED_ORIGINS } from "./http.ts";
import { buildRegistry, type RegistryConfig } from "./registry.ts";
import { RedisCache } from "./redisCache.ts";
import { InMemoryEventBus, type IndexerEventBus } from "./events.ts";
import { RedisEventBus } from "./redisEventBus.ts";

/** Shared setup between the API server and the background indexer, so they never drift apart. */

export function loadRootEnv(): void {
  const envPath = fileURLToPath(new URL("../../../../.env", import.meta.url));
  if (existsSync(envPath)) {
    try {
      process.loadEnvFile(envPath);
    } catch {
      // A malformed .env must not crash the process — fall through to defaults/public endpoints.
    }
  }
}

/**
 * The browser origins allowed to call the Explorer API (CORS), comma-separated:
 * `EXPLORER_ALLOWED_ORIGINS`, else `ACCOUNTS_ALLOWED_ORIGINS` (the same fallback the other feature
 * servers use), else the web UI's dev server. An empty value counts as unset, so the
 * `EXPLORER_ALLOWED_ORIGINS=` line in `.env.example` falls through instead of allowing nothing.
 */
export function allowedOriginsFromEnv(): string[] {
  const raw = process.env["EXPLORER_ALLOWED_ORIGINS"] || process.env["ACCOUNTS_ALLOWED_ORIGINS"];
  const origins = (raw ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  return origins.length > 0 ? origins : [...DEFAULT_ALLOWED_ORIGINS];
}

export function buildRegistryFromEnv(): ReturnType<typeof buildRegistry> {
  const config: RegistryConfig = {
    ethRpcUrl: process.env["ETH_RPC_URL"] ?? "https://ethereum-rpc.publicnode.com",
    etherscanApiKey: process.env["ETHERSCAN_API_KEY"],
    solanaRpcUrl: process.env["SOLANA_RPC_URL"] ?? "https://api.mainnet-beta.solana.com",
  };
  return buildRegistry(config);
}

/**
 * Every label dataset under data/labels/, one file per source (see data/labels/README.md). Order
 * is priority when two sources label the same address: sanctions lists first, so a sanctioned
 * address is never shown under a softer label; tags from every source are always all shown.
 */
const LABEL_DATASETS = ["ofac-sdn.json", "uk-sanctions-list.json", "safe-deployments.json"];

export function buildLabelStore(): LabelStore {
  return new CompositeLabelStore(
    LABEL_DATASETS.map((file) => new JsonFileLabelStore(fileURLToPath(new URL(`../../../../data/labels/${file}`, import.meta.url)))),
    // Community submissions (ADR 0007) come last: an ingested official label always wins, and this
    // reader is read-only — community labels only enter through the submit → review workflow.
    // Re-read on every lookup, so a submission or a moderator's decision shows up immediately.
    [new CommunityLabelReader(new JsonFileSubmissionStore(communityLabelsPath()))],
  );
}

/** RedisCache when REDIS_URL is set (so multiple processes share one cache/ranking), InMemoryCache otherwise. */
export function buildCache(): Cache {
  const redisUrl = process.env["REDIS_URL"];
  return redisUrl ? new RedisCache(redisUrl) : new InMemoryCache();
}

/**
 * The indexer → websocket event channel. Same rule as the cache: Redis pub/sub when REDIS_URL is
 * set (indexer and API server can be separate processes), in-process otherwise (only useful when
 * the indexer runs embedded in the API server — `EXPLORER_EMBEDDED_INDEXER=1`).
 */
export function buildEventBus(): IndexerEventBus {
  const redisUrl = process.env["REDIS_URL"];
  return redisUrl ? new RedisEventBus(redisUrl) : new InMemoryEventBus();
}
