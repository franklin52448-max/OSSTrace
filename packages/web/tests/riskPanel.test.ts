import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement, useState, type FunctionComponent } from "react";
import type { ChainId, TransactionSummary } from "@osstrace/core";
import { getRegion } from "./harness/forms.ts";
import { cleanup, click, consoleErrors, getButton, render, settle, text, waitFor } from "./harness/render.ts";
import { FixedHistoryAdapter, startStack, type Stack } from "./harness/servers.ts";

// The risk panel against the real Risk scoring API: real tag lookups in a real label store and a
// real Tracer hop search over the chain stand-in's configured history.

// Well-formed Ethereum addresses that exist only in this test's chain stand-in and label store.
const UNTAGGED = "0x1000000000000000000000000000000000000001";
const SANCTIONED = "0x2000000000000000000000000000000000000002";
const SENDS_TO_SANCTIONED = "0x3000000000000000000000000000000000000003";
const TX_HASH = "0x" + "ab".repeat(32);
const SANCTION_SOURCE = {
  description: "Test fixture: a sanctions-list entry this test adds to its own temp label store",
  url: "https://sanctionssearch.ofac.treas.gov/",
  addedAt: "2026-10-22",
};

const transfer = (direction: TransactionSummary["direction"]): TransactionSummary => ({
  chain: "ethereum",
  hash: TX_HASH,
  timestamp: "2026-10-01T00:00:00Z",
  from: SENDS_TO_SANCTIONED,
  to: SANCTIONED,
  valueNative: "1.5",
  direction,
});

let stack: Stack;
let RiskPanel: FunctionComponent<{ chain: ChainId; address: string }>;

before(async () => {
  stack = await startStack(
    new FixedHistoryAdapter(
      "ethereum",
      {},
      // Each side of the one transfer sees it in its own history, as a real chain reports it.
      { [SENDS_TO_SANCTIONED]: [transfer("out")], [SANCTIONED]: [transfer("in")] },
    ),
  );
  await stack.labelStore.addTag({ address: { chain: "ethereum", value: SANCTIONED }, tag: "sanctioned", source: SANCTION_SOURCE });
  ({ default: RiskPanel } = await import("../src/RiskPanel.tsx"));
});

after(async () => {
  await stack.close();
});

beforeEach(() => {
  consoleErrors.length = 0;
  stack.riskRequests.length = 0;
});
afterEach(cleanup);

async function compute(panel: HTMLElement): Promise<void> {
  await click(getButton("Compute", panel));
  await waitFor(() => text(panel).includes("Recompute"), "the risk result");
}

async function computeFor(address: string): Promise<HTMLElement> {
  await render(createElement(RiskPanel, { chain: "ethereum", address }));
  const panel = getRegion("Risk score");
  await compute(panel);
  return panel;
}

test("nothing is scored until the button is pressed, then exactly one request is made", async () => {
  await render(createElement(RiskPanel, { chain: "ethereum", address: UNTAGGED }));
  const panel = getRegion("Risk score");
  for (let i = 0; i < 5; i++) await settle();
  assert.ok(text(panel).includes("Based only on sourced tags"));
  assert.ok(!text(panel).includes("/ 100"));
  assert.deepEqual(stack.riskRequests, [], "no request on mount");

  await compute(panel);
  assert.deepEqual(stack.riskRequests, [`/risk/ethereum/${UNTAGGED}`]);
  assert.deepEqual(consoleErrors, []);
});

test("an untagged address with no risky neighbours scores a clean, complete NONE (0)", async () => {
  const shown = text(await computeFor(UNTAGGED));
  assert.ok(shown.includes("0 / 100"), shown);
  assert.ok(shown.includes("NONE"));
  assert.ok(!shown.includes("SEARCH INCOMPLETE"));
  assert.ok(shown.includes("No risk-tagged address within 2 hops"));
  assert.ok(shown.includes("Searched up to 2 hops, 25 most recent transactions per address"));
  assert.deepEqual(consoleErrors, []);
});

test("a directly sanctioned address scores SEVERE (100) and cites the tag's source", async () => {
  const panel = await computeFor(SANCTIONED);
  const shown = text(panel);
  assert.ok(shown.includes("100 / 100"), shown);
  assert.ok(shown.includes("SEVERE"));
  assert.ok(shown.includes('This address itself carries the risk tag "sanctioned"'));
  const source = [...panel.querySelectorAll("a")].find((a) => a.href === SANCTION_SOURCE.url);
  assert.ok(source, "the tag's source link");
  assert.ok(text(source).includes(`sanctioned: ${SANCTION_SOURCE.description}`));
  assert.ok(!shown.includes("Searched up to"), "a direct tag needs no hop search");
  assert.deepEqual(consoleErrors, []);
});

test("one hop from a sanctioned address scores HIGH (75), with the real path that links them", async () => {
  const shown = text(await computeFor(SENDS_TO_SANCTIONED));
  assert.ok(shown.includes("75 / 100"), shown);
  assert.ok(shown.includes("HIGH"));
  assert.ok(shown.includes("Nearest flagged address · 1 hop"));
  assert.ok(shown.includes(SANCTIONED));
  assert.ok(shown.includes("0x3000…0003 → 0x2000…0002 · tx 0xabab…abab"), shown);
  assert.deepEqual(consoleErrors, []);
});

test("an address the API rejects shows the API's own error", async () => {
  await render(createElement(RiskPanel, { chain: "ethereum", address: "0xnot-an-address" }));
  const panel = getRegion("Risk score");
  await click(getButton("Compute", panel));
  const alert = await waitFor(() => panel.querySelector('[role="alert"]'), "the error");
  assert.equal(text(alert).trim(), '"0xnot-an-address" is not a valid ethereum address');
  assert.deepEqual(consoleErrors, []);
});

test("a score never outlives the address it was computed for", async () => {
  let showAddress: (address: string) => void = () => undefined;
  function Lookup() {
    const [address, setAddress] = useState(SANCTIONED);
    showAddress = setAddress;
    return createElement(RiskPanel, { chain: "ethereum", address });
  }
  await render(createElement(Lookup));
  const panel = getRegion("Risk score");
  await compute(panel);
  assert.ok(text(panel).includes("SEVERE"));

  await act(async () => showAddress(UNTAGGED));
  assert.ok(!text(panel).includes("SEVERE"), "the previous address's score is gone");
  assert.ok(text(panel).includes("Compute"));
  assert.equal(stack.riskRequests.length, 1, "and the new address isn't scored until asked");
  assert.deepEqual(consoleErrors, []);
});
