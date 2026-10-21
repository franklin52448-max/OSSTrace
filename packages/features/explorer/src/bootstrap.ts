import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { InMemoryCache, JsonFileLabelStore, type Cache, type LabelStore } from "@opentrace/core";
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

export function buildLabelStore(): LabelStore {
  const labelsPath = fileURLToPath(new URL("../../../../data/labels/ofac-sdn.json", import.meta.url));
  return new JsonFileLabelStore(labelsPath);
}

/** RedisCache when REDIS_URL is set (so multiple processes share one cache/ranking), InMemoryCache otherwise. */
export function buildCache(): Cache {
  const redisUrl = process.env["REDIS_URL"];
  return redisUrl ? new RedisCache(redisUrl) : new InMemoryCache();
}
