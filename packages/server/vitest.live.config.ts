import { defineConfig } from "vitest/config";

// Hits the real providers (Blockscout, public Solana RPC, DefiLlama). Run: npm run test:live -w @osstrace/server
export default defineConfig({
  test: {
    include: ["tests/live/**/*.live.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: "forks",
    fileParallelism: false,
  },
});
