import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryCache } from "@osstrace/core";
import { allowedOriginsFromEnv, buildCache } from "../src/bootstrap.ts";
import { DEFAULT_ALLOWED_ORIGINS } from "../src/http.ts";
import { RedisCache } from "../src/redisCache.ts";

/**
 * Saves and restores exactly the env vars a test touches, so tests can run in any order without
 * leaking state into each other — these functions read `process.env` directly, so there's no way
 * to inject a fake environment short of mutating it for the duration of one test.
 *
 * `loadRootEnv()`'s malformed-.env branch is deliberately not tested: it reads the real repo-root
 * `.env`, and mutating that file from an automated test is too risky.
 */
async function withEnv(vars: Record<string, string | undefined>, run: () => void | Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) previous.set(key, process.env[key]);
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const NEITHER = { EXPLORER_ALLOWED_ORIGINS: undefined, ACCOUNTS_ALLOWED_ORIGINS: undefined };

test("allowedOriginsFromEnv: with neither variable set, defaults to the web dev origin", async () => {
  await withEnv(NEITHER, () => {
    assert.deepEqual(allowedOriginsFromEnv(), ["http://localhost:5301"]);
    assert.deepEqual(allowedOriginsFromEnv(), [...DEFAULT_ALLOWED_ORIGINS]);
  });
});

test("allowedOriginsFromEnv: returns a copy, so a caller can't mutate the shared default", async () => {
  await withEnv(NEITHER, () => {
    const origins = allowedOriginsFromEnv();
    origins.push("http://evil.example");
    assert.deepEqual(allowedOriginsFromEnv(), ["http://localhost:5301"]);
  });
});

test("allowedOriginsFromEnv: EXPLORER_ALLOWED_ORIGINS is split on commas and trimmed", async () => {
  await withEnv({ ...NEITHER, EXPLORER_ALLOWED_ORIGINS: " https://a.example , https://b.example,," }, () => {
    assert.deepEqual(allowedOriginsFromEnv(), ["https://a.example", "https://b.example"]);
  });
});

test("allowedOriginsFromEnv: EXPLORER_ALLOWED_ORIGINS wins over ACCOUNTS_ALLOWED_ORIGINS", async () => {
  await withEnv({ EXPLORER_ALLOWED_ORIGINS: "https://explorer.example", ACCOUNTS_ALLOWED_ORIGINS: "https://accounts.example" }, () => {
    assert.deepEqual(allowedOriginsFromEnv(), ["https://explorer.example"]);
  });
});

test("allowedOriginsFromEnv: falls back to ACCOUNTS_ALLOWED_ORIGINS when EXPLORER_ALLOWED_ORIGINS is unset", async () => {
  await withEnv({ EXPLORER_ALLOWED_ORIGINS: undefined, ACCOUNTS_ALLOWED_ORIGINS: "https://accounts.example,https://other.example" }, () => {
    assert.deepEqual(allowedOriginsFromEnv(), ["https://accounts.example", "https://other.example"]);
  });
});

test("allowedOriginsFromEnv: an empty EXPLORER_ALLOWED_ORIGINS counts as unset and falls through", async () => {
  await withEnv({ EXPLORER_ALLOWED_ORIGINS: "", ACCOUNTS_ALLOWED_ORIGINS: "https://accounts.example" }, () => {
    assert.deepEqual(allowedOriginsFromEnv(), ["https://accounts.example"]);
  });
  await withEnv({ EXPLORER_ALLOWED_ORIGINS: "", ACCOUNTS_ALLOWED_ORIGINS: "" }, () => {
    assert.deepEqual(allowedOriginsFromEnv(), ["http://localhost:5301"], "both empty must not mean an empty allowlist");
  });
});

test("allowedOriginsFromEnv: a value of only commas/whitespace falls back to the default, not an empty allowlist", async () => {
  // Unlike an empty string, " , " is truthy, so ACCOUNTS_ALLOWED_ORIGINS is never consulted —
  // but it parses to no origins, so the dev default applies.
  await withEnv({ EXPLORER_ALLOWED_ORIGINS: " , ", ACCOUNTS_ALLOWED_ORIGINS: "https://accounts.example" }, () => {
    assert.deepEqual(allowedOriginsFromEnv(), ["http://localhost:5301"]);
  });
});

test("buildCache: with no REDIS_URL, an in-process InMemoryCache", async () => {
  await withEnv({ REDIS_URL: undefined }, () => {
    const cache = buildCache();
    assert.ok(cache instanceof InMemoryCache);
    assert.ok(!(cache instanceof RedisCache));
  });
  await withEnv({ REDIS_URL: "" }, () => {
    assert.ok(buildCache() instanceof InMemoryCache, "an empty REDIS_URL counts as unset");
  });
});

test("buildCache: with REDIS_URL set, a RedisCache", async () => {
  // RedisCache's constructor connects eagerly (ioredis's default, no lazyConnect). The URL points
  // at a port nothing listens on and the client is closed straight away, before the connect
  // attempt can fail — so this only proves which class is selected, never needs a live Redis,
  // and leaves no reconnect loop holding the process open.
  await withEnv({ REDIS_URL: "redis://127.0.0.1:1" }, async () => {
    const cache = buildCache();
    try {
      assert.ok(cache instanceof RedisCache);
      assert.ok(!(cache instanceof InMemoryCache));
    } finally {
      await (cache as RedisCache).close();
    }
  });
});
