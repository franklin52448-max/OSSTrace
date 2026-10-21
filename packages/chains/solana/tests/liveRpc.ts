import type { TestContext } from "node:test";
import { Connection } from "@solana/web3.js";
import type { TransactionsResult } from "@opentrace/core";

// Shared by the live-network tests in this folder (not itself a test file). Same rule as every
// live test in this repo: an endpoint we can't use skips the test, it doesn't fail the suite.
export const RPC_URL = process.env["SOLANA_RPC_URL"] ?? "https://api.mainnet-beta.solana.com";

export async function rpcReachable(): Promise<boolean> {
  try {
    const conn = new Connection(RPC_URL, "confirmed");
    await conn.getVersion();
    return true;
  } catch {
    return false;
  }
}

/**
 * The ways a reachable public RPC still refuses to serve a request, all seen live while building
 * this: HTTP 429 rate limiting (routine on the shared mainnet-beta endpoint — web3.js has already
 * retried with backoff by then), a batch-size cap (publicnode allows one getTransaction per
 * batch), and web3.js rejecting a malformed batch response ("Expected an object, but received:
 * undefined") that the public endpoint returned intermittently under the same load.
 */
const REFUSED = /\b429\b|too many requests|maximum number of .* calls in a batch|expected an object, but received: undefined/i;

/** Runs a live call; a refusal (see REFUSED) skips the test with the real reason, anything else still fails. */
export async function liveOrSkip<T>(t: TestContext, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (REFUSED.test(message)) {
      t.skip(`${RPC_URL} refused the request (${message.slice(0, 120)}) — skipping live network test`);
      return undefined;
    }
    throw cause;
  }
}

/**
 * getRecentTransactions reports RPC refusals as `available: false` (per the ChainAdapter
 * contract) rather than throwing — skip on those, so only a real decoding/shape problem fails.
 */
export async function liveHistoryOrSkip(t: TestContext, run: () => Promise<TransactionsResult>): Promise<TransactionsResult | undefined> {
  const result = await liveOrSkip(t, run);
  if (result && !result.available && REFUSED.test(result.reason)) {
    t.skip(`${RPC_URL} refused the request (${result.reason.slice(0, 120)}) — skipping live network test`);
    return undefined;
  }
  return result;
}
