import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WORMHOLESCAN_API_URL, WormholescanResolver } from "../src/bridges/wormhole.ts";

// Live check against the real public Wormholescan API (no key). Same rule as every live test in
// this repo: an endpoint we can't reach, or one that rate-limits us, skips the test rather than
// failing the suite. Anything else (a changed response shape, malformed operations) fails it,
// because that would mean bridge tracing has silently stopped working.
const BASE_URL = process.env["WORMHOLESCAN_API_URL"] || DEFAULT_WORMHOLESCAN_API_URL;
const UNREACHABLE = /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|aborted|timeout|HTTP 429|HTTP 5\d\d/i;

// A very active Wormhole user on both chains, seen in the real recorded fixtures in this folder.
const ACTIVE_ETH_ADDRESS = "0x49719d256a5ea16bfa579ea16e95bea9fa41a452";

test("live: Wormholescan still answers an address lookup in the shape the classifier relies on", async (t) => {
  const resolver = new WormholescanResolver({ baseUrl: BASE_URL, timeoutMs: 20_000 });
  const result = await resolver.lookup({ chain: "ethereum", value: ACTIVE_ETH_ADDRESS }, 25);
  if (!result.available) {
    if (UNREACHABLE.test(result.reason)) {
      t.skip(`${BASE_URL} unusable from here (${result.reason}) — skipping live network test`);
      return;
    }
    assert.fail(`live lookup failed for a reason that isn't a network problem: ${result.reason}`);
  }
  assert.equal(result.malformed, 0, "live operations are missing fields the classifier needs");
  for (const transfer of result.transfers) {
    assert.ok(transfer.source.chain !== transfer.target.chain);
    assert.ok(transfer.source.txHash.length > 0 && transfer.target.txHash.length > 0);
    assert.ok(transfer.source.address === ACTIVE_ETH_ADDRESS || transfer.target.address === ACTIVE_ETH_ADDRESS);
  }
});
