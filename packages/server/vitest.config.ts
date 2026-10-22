import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/live/**", "node_modules/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
  },
});
