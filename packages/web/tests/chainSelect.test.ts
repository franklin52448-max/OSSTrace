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

const NEW_CHAINS = [
  ["arbitrum", "Arbitrum One", "ARB"],
  ["optimism", "OP Mainnet", "OP"],
  ["zora", "Zora", "ZORA"],
  ["lens", "Lens Chain", "LENS"],
  ["story", "Data Network", "DATA"],
] as const;

test("ChainSelect offers Arbitrum One, OP Mainnet, Zora, Lens Chain and the Data Network by their own names, after Base", async () => {
  assert.deepEqual(
    mod.CHAIN_OPTIONS.map((o) => o.value),
    ["ethereum", "solana", "bnb", "robinhood", "base", "arbitrum", "optimism", "zora", "lens", "story", "gnosis", "ronin", "rootstock"],
  );
  const picked: string[] = [];
  const r = await render(createElement(mod.ChainSelect as ComponentType<any>, { value: "ethereum", onChange: (c: string) => picked.push(c) }));
  await click(r.container.querySelector("button")!);
  for (const [, label] of NEW_CHAINS) assert.ok(optionLabels(r.container).includes(label), `no ${label} option`);
  const story = [...r.container.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.includes("Data Network"))!;
  await click(story);
  assert.deepEqual(picked, ["story"]);
});

test("the legacy-service picker never offers the five new chains", async () => {
  const r = await render(createElement(mod.ChainSelect as ComponentType<any>, { value: "ethereum", onChange: () => {}, chains: mod.LEGACY_SERVICE_CHAINS }));
  await click(r.container.querySelector("button")!);
  for (const [, label] of NEW_CHAINS) assert.ok(!optionLabels(r.container).includes(label));
});

test("ChainIcon draws each new chain as its own plain mark, in its own colour (a neutral grey 'D' for the Data Network)", async () => {
  const fills: Record<string, string> = { arbitrum: "#213147", optimism: "#FF0420", zora: "#000000", lens: "#00501E", story: "#6B7280" };
  for (const [chain] of NEW_CHAINS) {
    const r = await render(createElement(mod.ChainIcon, { chain }));
    assert.equal(r.container.querySelector("svg circle")?.getAttribute("fill"), fills[chain], chain);
    await cleanup();
  }
  const story = await render(createElement(mod.ChainIcon, { chain: "story" }));
  assert.ok(story.container.querySelector("svg path"), "no D on the Data Network's disc");
  assert.equal(story.container.textContent, "", "the mark adds no text of its own");
});

test("short badges: ARB / OP / ZORA / LENS / DATA -- never ETH for an ETH-gas chain that isn't Ethereum", () => {
  for (const [chain, , short] of NEW_CHAINS) assert.equal(CHAIN_SHORT[chain], short);
});

test("validateAddress checks the new chains' addresses by EVM shape, with each chain's own name", () => {
  for (const [chain, label] of NEW_CHAINS) {
    assert.equal(validateAddress(chain, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), null);
    assert.equal(validateAddress(chain, "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"), `Not ${chain === "arbitrum" || chain === "optimism" ? "an" : "a"} ${label} address (0x followed by 40 hex characters).`);
  }
});

test("supportedChainNames lists every chain, Ethereum first and Solana last", async () => {
  const { supportedChainNames } = await import("../src/chainList.ts");
  assert.equal(supportedChainNames("or"), "Ethereum, BNB Chain, Robinhood Chain, Base, Arbitrum One, OP Mainnet, Zora, Lens Chain, Data Network, Gnosis Chain, Ronin, Rootstock, ZetaChain, Mythos, HyperEVM or Solana");
  assert.ok(supportedChainNames("and").endsWith("HyperEVM and Solana"));
});

const GRR_CHAINS = [
  ["gnosis", "Gnosis Chain", "GNO"],
  ["ronin", "Ronin", "RON"],
  ["rootstock", "Rootstock", "RBTC"],
] as const;

test("ChainSelect offers Gnosis Chain, Ronin and Rootstock by their own names, after the Data Network", async () => {
  assert.deepEqual(mod.CHAIN_OPTIONS.slice(-4).map((o) => o.value), ["story", "gnosis", "ronin", "rootstock"]);
  const picked: string[] = [];
  const r = await render(createElement(mod.ChainSelect as ComponentType<any>, { value: "ethereum", onChange: (c: string) => picked.push(c) }));
  await click(r.container.querySelector("button")!);
  for (const [, label] of GRR_CHAINS) assert.ok(optionLabels(r.container).includes(label), `no ${label} option`);
  const rsk = [...r.container.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.includes("Rootstock"))!;
  await click(rsk);
  assert.deepEqual(picked, ["rootstock"]);
});

test("the legacy-service picker never offers Gnosis Chain, Ronin or Rootstock", async () => {
  const r = await render(createElement(mod.ChainSelect as ComponentType<any>, { value: "ethereum", onChange: () => {}, chains: mod.LEGACY_SERVICE_CHAINS }));
  await click(r.container.querySelector("button")!);
  for (const [, label] of GRR_CHAINS) assert.ok(!optionLabels(r.container).includes(label));
});

test("ChainIcon draws Gnosis Chain, Ronin and Rootstock as ringed discs, each in its own colour and none a neighbour's plain disc", async () => {
  const marks: Record<string, [string, string]> = { gnosis: ["#133629", "#F0EBDE"], ronin: ["#1273EA", "#ffffff"], rootstock: ["#FF9100", "#000000"] };
  for (const [chain] of GRR_CHAINS) {
    const r = await render(createElement(mod.ChainIcon, { chain }));
    const circles = [...r.container.querySelectorAll("svg circle")];
    assert.equal(circles[0]?.getAttribute("fill"), marks[chain]![0], chain);
    assert.equal(circles[1]?.getAttribute("stroke"), marks[chain]![1], chain);
    assert.equal(r.container.textContent, "", "the mark adds no text of its own");
    await cleanup();
  }
});

test("short badges: GNO / RON / RBTC -- not xDAI for Gnosis Chain (bridged DAI is an Ethereum token too)", () => {
  for (const [chain, , short] of GRR_CHAINS) assert.equal(CHAIN_SHORT[chain], short);
});

test("validateAddress checks Gnosis Chain, Ronin and Rootstock addresses by EVM shape, with each chain's own name", () => {
  for (const [chain, label] of GRR_CHAINS) {
    assert.equal(validateAddress(chain, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), null);
    assert.equal(validateAddress(chain, "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"), `Not a ${label} address (0x followed by 40 hex characters).`);
  }
});
