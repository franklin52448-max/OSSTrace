import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement, type ComponentType } from "react";
import type { TransactionSummary } from "@osstrace/core";
import { choose, fill, getControl } from "./harness/forms.ts";
import { cleanup, click, consoleErrors, getButton, render, text, waitFor } from "./harness/render.ts";
import { FixedHistoryAdapter, startStack, type Stack } from "./harness/servers.ts";

// The Tracer view against the real Tracer API: a real multi-hop search over the chain stand-in's
// configured history, and real Wormhole bridge following through the real WormholescanResolver
// (pointed at the harness's local Wormholescan, serving a real recorded response).

// Well-formed Ethereum addresses that exist only in this test's chain stand-in.
const CENTER = "0xc000000000000000000000000000000000000001";
const PAID = "0xc000000000000000000000000000000000000002"; // CENTER sent to it
const PAYER = "0xc000000000000000000000000000000000000003"; // it sent to CENTER
const ONWARD = "0xc000000000000000000000000000000000000004"; // PAID sent on to it
const hash = (n: number): string => "0x" + String(n).repeat(64);

function tx(n: number, from: string, to: string, valueNative: string, direction: TransactionSummary["direction"], day: number): TransactionSummary {
  return { chain: "ethereum", hash: hash(n), timestamp: `2026-10-0${day}T12:00:00Z`, from, to, valueNative, direction };
}

// The real Ethereum address and real recorded Wormholescan response that @osstrace/tracer's own
// bridge tests use (tests/fixtures/, recorded 2026-10-22, unedited).
const ETH_NODE = "0x49719d256a5ea16bfa579ea16e95bea9fa41a452";
const ETH_OPS: unknown = JSON.parse(
  readFileSync(new URL("../../features/tracer/tests/fixtures/wormholescan-operations-eth-0x49719d.json", import.meta.url), "utf8"),
);
const BRIDGE_SOURCE_TX = "0x465e0cb533b271cb735bad4eb2a9fd643faf172221487b7aa7bb6cc4880693b9";
const BRIDGE_TARGET_TX = "5BmKXqEv1a9CbFHEA2GYkyvMAJSrXfNWAG6xMzcqmV4BFahcRNBToXsVpzjt7QY9sfqtiBBXsn5VawTPrY2qXhg2";

let stack: Stack;
let TracerView: ComponentType;

before(async () => {
  stack = await startStack(
    new FixedHistoryAdapter(
      "ethereum",
      {},
      {
        [CENTER]: [tx(1, CENTER, PAID, "2", "out", 3), tx(2, PAYER, CENTER, "0.5", "in", 2)],
        [PAID]: [tx(3, PAID, ONWARD, "1.9", "out", 4), tx(1, CENTER, PAID, "2", "in", 3)],
        [PAYER]: [tx(2, PAYER, CENTER, "0.5", "out", 2)],
      },
    ),
  );
  stack.wormholescanResponses.set(ETH_NODE, ETH_OPS);
  ({ default: TracerView } = await import("../src/TracerView.tsx"));
});

after(async () => {
  await stack.close();
});

beforeEach(() => {
  consoleErrors.length = 0;
});
afterEach(cleanup);

/** The trace result's section whose header is `title`. */
function section(title: string): HTMLElement | null {
  return [...document.querySelectorAll("section")].find((s) => text(s.querySelector("h2") ?? s).trim() === title) ?? null;
}

test("expand a single-chain graph two hops out: every real edge, and what wasn't expanded and why", async () => {
  await render(createElement(TracerView));
  await fill(getControl("Trace from this address"), CENTER);
  assert.ok(getButton("Expand graph"), "no To address: the button says it'll expand the graph");
  await click(getButton("Expand graph"));
  const graph = await waitFor(() => section("Expanded graph"), "the expanded graph");

  const shown = text(graph);
  assert.ok(shown.includes("3 nodes expanded"), shown);
  assert.ok(shown.includes("3 real edges"), shown);
  for (const n of [1, 2, 3]) assert.ok(shown.includes(hash(n)), `edge ${n} listed`);
  assert.ok(shown.includes("0xc000…0001 → 0xc000…0002"), "CENTER → PAID");
  assert.ok(shown.includes("0xc000…0003 → 0xc000…0001"), "PAYER → CENTER");
  assert.ok(shown.includes("0xc000…0002 → 0xc000…0004"), "PAID → ONWARD");
  assert.ok(shown.includes("2 native") && shown.includes("0.5 native") && shown.includes("1.9 native"));
  const etherscan = [...graph.querySelectorAll("a")].map((a) => a.href);
  assert.ok(etherscan.includes(`https://etherscan.io/tx/${hash(1)}`));

  // ONWARD is two hops out: reached, but past the hop limit.
  const notExpanded = section("Not expanded further");
  assert.ok(notExpanded);
  assert.ok(text(notExpanded).includes("1 depth-cap"));
  assert.ok(text(notExpanded).includes("0xc000…0004"));
  assert.ok(text(notExpanded).includes("reached, not expanded — past the hop limit"));
  // Bridges weren't asked for: nothing about them is shown.
  assert.equal(section("Bridge activity not followed"), null);
  assert.deepEqual(consoleErrors, []);
});

test("with one hop, the same address's neighbours become the frontier", async () => {
  await render(createElement(TracerView));
  await fill(getControl("Trace from this address"), CENTER);
  await choose(getControl<HTMLSelectElement>("Max hops"), "1");
  await click(getButton("Expand graph"));
  const graph = await waitFor(() => section("Expanded graph"), "the expanded graph");
  assert.ok(text(graph).includes("1 nodes expanded"));
  assert.ok(text(graph).includes("2 real edges"));
  const notExpanded = section("Not expanded further");
  assert.ok(notExpanded && text(notExpanded).includes("2 depth-cap"));
  assert.deepEqual(consoleErrors, []);
});

test("find a single-chain path, hop by hop", async () => {
  await render(createElement(TracerView));
  await fill(getControl("Trace from this address"), CENTER);
  await fill(getControl("Does a path reach this address"), ONWARD);
  await click(getButton("Find path"));
  await waitFor(() => text().includes("Path found"), "the path result");
  assert.ok(text().includes("Path found — 2 hops, every edge matches the filters."), text());
  const path = section("Real path, hop by hop");
  assert.ok(path);
  const hops = [...path.querySelectorAll("li")].map((li) => text(li));
  assert.equal(hops.length, 2);
  assert.ok(hops[0]?.includes(hash(1)) && hops[0].includes("0xc000…0001 → 0xc000…0002"));
  assert.ok(hops[1]?.includes(hash(3)) && hops[1].includes("0xc000…0002 → 0xc000…0004"));
  assert.deepEqual(consoleErrors, []);
});

test("a path that doesn't exist is reported as not found, with how far the search went", async () => {
  await render(createElement(TracerView));
  await fill(getControl("Trace from this address"), ONWARD);
  await fill(getControl("Does a path reach this address"), CENTER);
  await click(getButton("Find path"));
  await waitFor(() => text().includes("No matching path found"), "the not-found result");
  // ONWARD has no history at all: the search checked it, had nothing to follow, and stopped
  // after that first hop (it reports the hops it actually searched, not the limit).
  assert.match(text(), /No matching path found within 1 hop \(1 addresses checked\)/);
  assert.equal(section("Real path, hop by hop"), null);
  assert.deepEqual(consoleErrors, []);
});

test("the API's own error for a malformed address is shown", async () => {
  await render(createElement(TracerView));
  await fill(getControl("Trace from this address"), "0x1234");
  await click(getButton("Expand graph"));
  const alert = await waitFor(() => document.querySelector('[role="alert"]'), "the error");
  assert.equal(text(alert).trim(), '"0x1234" is not a valid ethereum address');
  assert.deepEqual(consoleErrors, []);
});

test("Follow Wormhole bridges: a real recorded Ethereum → Solana transfer is drawn as a bridge hop", async () => {
  await render(createElement(TracerView));
  await fill(getControl("Trace from this address"), ETH_NODE);
  await choose(getControl<HTMLSelectElement>("Max hops"), "1");
  const toggle = getControl<HTMLInputElement>("Follow Wormhole bridge hops across chains");
  await click(toggle);
  assert.equal(toggle.checked, true);
  await click(getButton("Expand graph"));
  const graph = await waitFor(() => section("Expanded graph"), "the expanded graph");

  const shown = text(graph);
  assert.ok(shown.includes("bridge · wormhole ethereum → solana"), shown);
  assert.ok(shown.includes("PORTAL_TOKEN_BRIDGE"));
  assert.ok(shown.includes(`ethereum: ${BRIDGE_SOURCE_TX}`));
  assert.ok(shown.includes(`solana: ${BRIDGE_TARGET_TX}`));
  const links = [...graph.querySelectorAll("a")].map((a) => a.href);
  assert.ok(links.includes(`https://etherscan.io/tx/${BRIDGE_SOURCE_TX}`));
  assert.ok(links.includes(`https://solscan.io/tx/${BRIDGE_TARGET_TX}`));
  assert.ok(
    [...graph.querySelectorAll("a")].some((a) => text(a).trim() === "Wormholescan record"),
    "the bridge hop links its Wormholescan evidence",
  );

  // The recorded response's BSC → Ethereum transfer can't be followed (BSC isn't supported),
  // and the view says so instead of dropping it.
  const deadEnds = section("Bridge activity not followed");
  assert.ok(deadEnds);
  assert.ok(text(deadEnds).includes("the other side is on a chain OSSTrace doesn't support"), text(deadEnds));
  assert.deepEqual(consoleErrors, []);
});
