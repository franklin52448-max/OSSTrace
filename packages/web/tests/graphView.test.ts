import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement, type ComponentType } from "react";
import type { TransactionSummary } from "@osstrace/core";
import { window } from "./harness/env.ts";
import { fill, getControl, getRegion } from "./harness/forms.ts";
import { cleanup, click, consoleErrors, getButton, render, text, waitFor } from "./harness/render.ts";
import { FixedHistoryAdapter, startStack, type Stack } from "./harness/servers.ts";

// The graph view against the real Visualizer API: a real one-hop graph built from the chain
// stand-in's configured history, with labels from the real label store.

// Well-formed Ethereum addresses that exist only in this test's chain stand-in and label store.
const CENTER = "0xd000000000000000000000000000000000000001";
const PAID = "0xd000000000000000000000000000000000000002";
const PAYER = "0xd000000000000000000000000000000000000003";
const hash = (n: number): string => "0x" + String(n).repeat(64);
const PAID_LABEL = "Test fixture: an exchange deposit address";

function tx(n: number, from: string, to: string, valueNative: string, direction: TransactionSummary["direction"]): TransactionSummary {
  return { chain: "ethereum", hash: hash(n), timestamp: `2026-10-0${n}T12:00:00Z`, from, to, valueNative, direction };
}

let stack: Stack;
let GraphView: ComponentType;

// Two browser APIs jsdom doesn't implement, which the graph calls. jsdom does no layout, so a
// ResizeObserver that never reports a resize is exactly what a real one would do here; pointer
// capture has no observable effect without real pointer hardware.
class NoLayoutResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

before(async () => {
  (globalThis as Record<string, unknown>)["ResizeObserver"] ??= NoLayoutResizeObserver;
  const elementProto = window.Element.prototype as unknown as Record<string, unknown>;
  elementProto["setPointerCapture"] ??= () => undefined;

  stack = await startStack(
    new FixedHistoryAdapter(
      "ethereum",
      {},
      {
        [CENTER]: [
          tx(1, CENTER, PAID, "2", "out"),
          tx(2, CENTER, PAID, "0.25", "out"),
          tx(3, PAYER, CENTER, "0.5", "in"),
          tx(4, CENTER, CENTER, "1", "self"),
        ],
        [PAID]: [tx(1, CENTER, PAID, "2", "in"), tx(2, CENTER, PAID, "0.25", "in"), tx(5, PAID, PAYER, "9", "out")],
      },
    ),
  );
  await stack.labelStore.addLabel({
    address: { chain: "ethereum", value: PAID },
    name: PAID_LABEL,
    confidence: "verified",
    source: { description: "Test fixture label in this test's own temp label store", url: "https://example.com/test-fixture", addedAt: "2026-10-22" },
  });
  ({ default: GraphView } = await import("../src/GraphView.tsx"));
});

after(async () => {
  await stack.close();
});

beforeEach(() => {
  consoleErrors.length = 0;
});
afterEach(cleanup);

async function graph(address: string): Promise<HTMLElement> {
  await render(createElement(GraphView));
  await fill(getControl("Address to graph"), address);
  await click(getButton("Graph it"));
  return waitFor(() => document.querySelector<HTMLElement>('section[aria-label="Transaction graph"]'), "the graph");
}

/** The SVG group drawn for a node: the `<g>` whose tooltip names its address. */
function nodeGroup(address: string): SVGGElement {
  const title = [...document.querySelectorAll("svg title")].find((t) => (t.textContent ?? "").includes(address));
  const group = title?.parentElement;
  assert.ok(group, `a drawn node for ${address}`);
  return group as unknown as SVGGElement;
}

/** A real click on an SVG node: the pointerdown/pointerup pair the graph listens for. */
async function clickNode(address: string): Promise<void> {
  const group = nodeGroup(address);
  await act(async () => {
    group.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 10, clientY: 10 }));
    group.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 10, clientY: 10 }));
  });
}

test("a one-hop graph: every counterparty drawn as a node, every transfer as an edge, and what wasn't drawn", async () => {
  const section = await graph(CENTER);
  const header = text(section);
  assert.ok(header.includes("2 counterparties"), header);
  assert.ok(header.includes("3 transfers drawn"), header);
  assert.ok(header.includes("4 txs fetched"), header);
  assert.ok(header.includes("1 not drawn"), header);

  const svg = section.querySelector("svg");
  assert.ok(svg);
  assert.equal(svg.getAttribute("aria-label"), `Transaction graph for ${CENTER}`);
  // Three nodes (center + two counterparties), each with its tooltip.
  assert.equal(svg.querySelectorAll("title").length, 3);
  for (const address of [CENTER, PAID, PAYER]) nodeGroup(address);
  // The labelled node shows its label's name; the others their short address.
  assert.ok(text(nodeGroup(PAID)).includes(PAID_LABEL.slice(0, 23)));
  assert.ok(text(nodeGroup(PAYER)).includes("0xd000…0003"));
  // Two links: CENTER→PAID (two transfers, so "×2") and PAYER→CENTER.
  assert.equal(svg.querySelectorAll("path[marker-end]").length, 2);
  assert.ok(text(svg).includes("×2"));

  // The self-transfer is fetched but never drawn, and the view says why.
  const details = document.querySelector("details");
  assert.ok(details);
  assert.ok(text(details).includes("1 fetched transaction not drawn as edges"));
  assert.ok(text(details).includes("self-transfer (sent to itself)"));
  assert.ok(text(details).includes(hash(4)));

  // The queried address is selected to start with: its totals cover exactly the drawn transfers.
  const panel = getRegion("Selected node");
  assert.ok(text(panel).includes("Queried address"));
  assert.ok(text(panel).includes(CENTER));
  assert.ok(text(panel).includes("Received (1)0.5 ETH"), text(panel));
  assert.ok(text(panel).includes("Sent (2)2.25 ETH"), text(panel));
  assert.ok(text(panel).includes("No label on record."));
  assert.deepEqual(consoleErrors, []);
});

test("click a counterparty to inspect it, then step outward to its own graph", async () => {
  await graph(CENTER);
  await clickNode(PAID);
  const panel = getRegion("Selected node");
  assert.ok(text(panel).includes("Counterparty"));
  assert.ok(text(panel).includes(PAID_LABEL));
  assert.ok(text(panel).includes("Source: Test fixture label in this test's own temp label store"));
  assert.ok(text(panel).includes("Received (2)2.25 ETH"), text(panel));

  await click(getButton("Graph this address", panel));
  await waitFor(() => document.querySelector(`svg[aria-label="Transaction graph for ${PAID}"]`), "PAID's own graph");
  assert.equal(getControl<HTMLInputElement>("Address to graph").value, PAID, "the toolbar follows the step");
  const section = getRegion("Transaction graph");
  assert.ok(text(section).includes("2 counterparties"), text(section));
  assert.ok(text(section).includes("3 transfers drawn"));
  assert.ok(text(getRegion("Selected node")).includes("Queried address"));
  assert.deepEqual(consoleErrors, []);
});

test("the zoom controls change the drawn graph's real transform", async () => {
  const section = await graph(CENTER);
  const transform = (): string => section.querySelector("svg > g")?.getAttribute("transform") ?? "";
  const before = transform();
  const scale = (): number => Number(/scale\(([^)]+)\)/.exec(transform())?.[1]);
  const start = scale();
  await click(getControl<HTMLButtonElement>("Zoom in"));
  assert.notEqual(transform(), before);
  assert.ok(Math.abs(scale() - start * 1.3) < 1e-9, `zoomed in by 1.3x (${start} -> ${scale()})`);
  await click(getControl<HTMLButtonElement>("Zoom out"));
  assert.ok(Math.abs(scale() - start) < 1e-9, "and back out");
  assert.deepEqual(consoleErrors, []);
});

test("the API's own error for a malformed address is shown", async () => {
  await render(createElement(GraphView));
  await fill(getControl("Address to graph"), "not-an-address");
  await click(getButton("Graph it"));
  const alert = await waitFor(() => document.querySelector('[role="alert"]'), "the error");
  assert.match(text(alert), /not a valid ethereum address/);
  assert.deepEqual(consoleErrors, []);
});
