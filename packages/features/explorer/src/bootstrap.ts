import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CompositeLabelStore, InMemoryCache, JsonFileLabelStore, type Cache, type LabelStore } from "@opentrace/core";
import { buildRegistry, type RegistryConfig } from "./registry.ts";
import { RedisCache } from "./redisCache.ts";

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
  );
}

/** RedisCache when REDIS_URL is set (so multiple processes share one cache/ranking), InMemoryCache otherwise. */
export function buildCache(): Cache {
  const redisUrl = process.env["REDIS_URL"];
  return redisUrl ? new RedisCache(redisUrl) : new InMemoryCache();
}
