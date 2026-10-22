import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import type { Balance, ChainAdapter, TransactionSummary, TransactionsResult } from "@osstrace/core";
import { cleanup, consoleErrors, render, settle, text, waitFor } from "./harness/render.ts";
import { FixedBalanceAdapter, startLiveExplorer, startStack, type LiveExplorer, type Stack } from "./harness/servers.ts";

// useLiveTransactions + LiveBadge against the Explorer's real /stream websocket (ADR 0013): real
// session auth against the real accounts service, a real Indexer finding a real new transaction in
// the adapter's history, a real push over a real socket into the hook. The only stand-ins are the
// chain (a history array the test edits) and the indexer's timer (each cycle is run on demand).

const WATCHED = "0x41675c099f32341bf84bfc5382af534df5c7461a";
const UNWATCHED = "0x252a8bd2319d8a555b872990601221b3a2053bce";

class ScriptedAdapter implements ChainAdapter {
  readonly chain = "ethereum" as const;
  history: TransactionSummary[] = [];

  async getBalance(address: string): Promise<Balance> {
    return { chain: "ethereum", address, native: { symbol: "ETH", amount: "1", decimals: 18 }, asOf: "2026-10-22T12:00:00Z" };
  }

  async getRecentTransactions(_address: string, limit: number): Promise<TransactionsResult> {
    return { available: true, transactions: this.history.slice(0, limit) };
  }
}

const tx = (n: number): TransactionSummary => ({
  chain: "ethereum",
  hash: `0xlive${n}`,
  timestamp: new Date(Date.UTC(2026, 9, 22, 12, n)).toISOString(),
  from: "0xsender",
  to: WATCHED,
  valueNative: "1",
  direction: "in",
});

let stack: Stack;
let live: LiveExplorer;
let adapter: ScriptedAdapter;
let token: string;
let LiveStream: typeof import("../src/LiveStream.tsx");

before(async () => {
  stack = await startStack(new FixedBalanceAdapter("ethereum", {}));
  adapter = new ScriptedAdapter();
  live = await startLiveExplorer(stack.accountService, adapter);
  const signup = await stack.accountService.signup("watcher@example.com", "correct horse battery staple");
  assert.ok(signup.ok);
  token = signup.session.token;
  LiveStream = await import("../src/LiveStream.tsx");

  // A real lookup through the streaming Explorer's own HTTP API is what makes an address popular
  // enough for the indexer to watch; the first cycle is its baseline.
  adapter.history = [tx(2), tx(1)];
  const res = await fetch(`${live.url}/address/ethereum/${WATCHED}`);
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  await live.indexer.runCycle();
});

after(async () => {
  await live.close();
  await stack.close();
});

beforeEach(() => {
  consoleErrors.length = 0;
});
afterEach(cleanup);

/** The hook's state as a real component shows it: the badge, plus each pushed transaction's hash. */
function probe(address: string, sessionToken: string | null) {
  return function LiveProbe() {
    const state = LiveStream.useLiveTransactions<TransactionSummary>(live.url, "ethereum", address, sessionToken);
    return createElement(
      "div",
      null,
      createElement(LiveStream.LiveBadge, { state }),
      createElement(
        "ul",
        null,
        state.incoming.map((t) => createElement("li", { key: t.hash }, t.hash)),
      ),
    );
  };
}

test("signed out: the badge says 'Live: sign in' and no socket is ever opened", async () => {
  const before = live.upgrades();
  const view = await render(createElement(probe(WATCHED, null)));
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(text().trim(), "Live: sign in");
  assert.equal(live.upgrades(), before, "no websocket upgrade reached the Explorer");
  await view.unmount();
  assert.deepEqual(consoleErrors, []);
});

test("signed in: authenticates, subscribes, shows LIVE, and receives the transaction the next indexer cycle finds", async () => {
  const view = await render(createElement(probe(WATCHED, token)));
  await waitFor(() => text().includes("LIVE"), "the subscribe ack (live)");
  assert.equal(live.hub.clientCount, 1, "one authenticated client on the real hub");
  assert.ok(!text().includes("0xlive"), "nothing pushed before anything new lands");

  adapter.history.unshift(tx(3));
  await live.indexer.runCycle();
  await waitFor(() => text().includes("0xlive3"), "the pushed transaction");
  assert.ok(!text().includes("0xlive2"), "only the new transaction is pushed, not the baseline");

  // A cycle that finds nothing new pushes nothing.
  await live.indexer.runCycle();
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(text().match(/0xlive/g)?.length, 1);

  await view.unmount();
  await waitFor(() => live.hub.connectionCount === 0, "the socket to close on unmount");
  assert.deepEqual(consoleErrors, []);
});

test("signed in, but the address isn't one the indexer watches: 'Not live'", async () => {
  const view = await render(createElement(probe(UNWATCHED, token)));
  await waitFor(() => text().includes("Not live"), "the subscribe ack (not live)");
  await view.unmount();
  assert.deepEqual(consoleErrors, []);
});

test("a token the accounts service doesn't know is refused (close 1008): 'Live: session refused'", async () => {
  const view = await render(createElement(probe(WATCHED, "not-a-real-session-token")));
  await waitFor(() => text().includes("Live: session refused"), "the refusal");
  await view.unmount();
  assert.deepEqual(consoleErrors, []);
});
