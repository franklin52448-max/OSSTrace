import { test } from "node:test";
import assert from "node:assert/strict";
import { EthereumAdapter } from "@osstrace/chain-ethereum";
import { SolanaAdapter } from "@osstrace/chain-solana";
import { SUPPORTED_CHAINS } from "../src/address.ts";
import { buildRegistry } from "../src/registry.ts";

/**
 * The real `buildRegistry` wiring — every other Explorer test hands the server its own stand-in
 * registry, so this is the only place the actual chain adapters it constructs are checked.
 * Constructing an adapter makes no network call. The one adapter call made here (Ethereum's
 * transaction history) runs against a replaced `globalThis.fetch` that records the request and
 * never reaches the network, so it proves what the adapter was configured with, offline.
 */
const CONFIG = { ethRpcUrl: "http://127.0.0.1:1/eth", solanaRpcUrl: "http://127.0.0.1:1/sol" };

/** Swaps `globalThis.fetch` for one test and always restores it. */
async function withFetch(stand: typeof fetch, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = stand;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("buildRegistry registers exactly ethereum and solana, matching SUPPORTED_CHAINS", () => {
  const registry = buildRegistry(CONFIG);
  assert.deepEqual([...registry.keys()].sort(), ["ethereum", "solana"]);
  assert.deepEqual([...registry.keys()].sort(), [...SUPPORTED_CHAINS].sort(), "address.ts's SUPPORTED_CHAINS must match what's registered");
});

test("buildRegistry's values are the real chain adapters, each for its own chain", () => {
  const registry = buildRegistry(CONFIG);
  const eth = registry.get("ethereum");
  const sol = registry.get("solana");
  assert.ok(eth instanceof EthereumAdapter, "ethereum must be the real EthereumAdapter");
  assert.ok(sol instanceof SolanaAdapter, "solana must be the real SolanaAdapter");
  assert.equal(eth.chain, "ethereum");
  assert.equal(sol.chain, "solana");
});

test("buildRegistry builds fresh adapter instances on every call", () => {
  const a = buildRegistry(CONFIG);
  const b = buildRegistry(CONFIG);
  assert.notEqual(a, b);
  assert.notEqual(a.get("ethereum"), b.get("ethereum"));
  assert.notEqual(a.get("solana"), b.get("solana"));
});

test("with no etherscanApiKey, the Ethereum adapter reports history unavailable without any request", async () => {
  const registry = buildRegistry({ ...CONFIG, etherscanApiKey: undefined });
  let calls = 0;
  await withFetch(
    (async () => {
      calls++;
      throw new Error("fetch must not be called without an API key");
    }) as typeof fetch,
    async () => {
      const result = await registry.get("ethereum")!.getRecentTransactions("0xabc", 5);
      assert.equal(result.available, false);
      assert.ok(!result.available && /ETHERSCAN_API_KEY not configured/.test(result.reason), JSON.stringify(result));
    },
  );
  assert.equal(calls, 0);
});

test("a set etherscanApiKey is passed through to the Ethereum adapter's Etherscan requests", async () => {
  const registry = buildRegistry({ ...CONFIG, etherscanApiKey: "test-key-123" });
  const requested: URL[] = [];
  await withFetch(
    (async (input: string | URL | Request) => {
      requested.push(new URL(input instanceof Request ? input.url : input.toString()));
      throw new Error("offline test: request recorded, not sent");
    }) as typeof fetch,
    async () => {
      const result = await registry.get("ethereum")!.getRecentTransactions("0xabc", 5);
      // The recorded fetch throws, so the adapter honestly reports it — but past the key check.
      assert.equal(result.available, false);
      assert.ok(!result.available && /offline test/.test(result.reason), JSON.stringify(result));
    },
  );
  assert.ok(requested.length > 0, "a configured key must lead to a real Etherscan request");
  for (const url of requested) assert.equal(url.searchParams.get("apikey"), "test-key-123");
});
