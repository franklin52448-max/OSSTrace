import { afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { createElement, type ComponentType } from "react";
import "./harness/env.ts";
import { cleanup, click, render } from "./harness/render.ts";

// The app-wide chain picker against the real component: Base is offered (with its own mark) wherever
// the picker serves the OSSTrace server's chains, and nowhere a legacy-service view restricts it.

type ChainSelectModule = typeof import("../src/ChainSelect.tsx");
let mod: ChainSelectModule;
let validateAddress: typeof import("../src/kit/validation.ts").validateAddress;
let CHAIN_SHORT: typeof import("../src/kit/ChainBadge.tsx").CHAIN_SHORT;

before(async () => {
  mod = await import("../src/ChainSelect.tsx");
  ({ validateAddress } = await import("../src/kit/validation.ts"));
  ({ CHAIN_SHORT } = await import("../src/kit/ChainBadge.tsx"));
});

afterEach(cleanup);

const optionLabels = (root: HTMLElement) => [...root.querySelectorAll('[role="option"]')].map((o) => o.textContent?.trim());

test("CHAIN_OPTIONS lists Base by its own name", () => {
  assert.equal(mod.CHAIN_OPTIONS.find((o) => o.value === "base")?.label, "Base");
});

test("ChainSelect offers Base by default and reports it as chosen", async () => {
  const picked: string[] = [];
  const r = await render(createElement(mod.ChainSelect as ComponentType<any>, { value: "ethereum", onChange: (c: string) => picked.push(c) }));
  await click(r.container.querySelector("button")!);
  assert.ok(optionLabels(r.container).includes("Base"), "no Base option");
  const base = [...r.container.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.includes("Base"))!;
  await click(base);
  assert.deepEqual(picked, ["base"]);
});

test("ChainSelect restricted to LEGACY_SERVICE_CHAINS (Ethereum+Solana-only backends) never offers Base", async () => {
  const r = await render(createElement(mod.ChainSelect as ComponentType<any>, { value: "ethereum", onChange: () => {}, chains: mod.LEGACY_SERVICE_CHAINS }));
  await click(r.container.querySelector("button")!);
  assert.ok(!optionLabels(r.container).includes("Base"));
});

test("ChainIcon draws Base as its own blue disc", async () => {
  const r = await render(createElement(mod.ChainIcon, { chain: "base" }));
  const circle = r.container.querySelector("svg circle");
  assert.ok(circle, "no Base mark");
  assert.equal(circle.getAttribute("fill"), "#0052FF");
});

test("Base's short badge is BASE, never ETH -- it pays gas in ETH, but it isn't Ethereum", () => {
  assert.equal(CHAIN_SHORT.base, "BASE");
  assert.equal(CHAIN_SHORT.ethereum, "ETH");
});

test("validateAddress checks Base addresses by EVM shape, never lets anything through", () => {
  assert.equal(validateAddress("base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), null);
  assert.equal(validateAddress("base", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"), "Not a Base address (0x followed by 40 hex characters).");
});
