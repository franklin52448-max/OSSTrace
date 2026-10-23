import { before, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement, type ComponentType } from "react";
import { window } from "./harness/env.ts";
import { cleanup, render } from "./harness/render.ts";

// "Every wallet node gets copy-address + open-on-explorer, every transaction row gets open-tx-on-
// explorer" (user request). explorers.ts's pure URL-building is tested directly; AddressChip and
// TransferTable are tested as real DOM components -- window.open is swapped for a recorder for the
// life of this file, the same way other test files here swap globalThis.fetch, since jsdom's own
// window.open is a silent no-op and can't tell us what URL a click actually asked to open.

type ExplorersModule = typeof import("../src/explorers.ts");
let explorers: ExplorersModule;
let AddressChip: ComponentType<{ info: { address: string; chain: "ethereum" | "solana" }; showHash?: boolean; showActions?: boolean }>;
let TransferTable: ComponentType<any>;

const opened: { url: string; target: string | undefined; features: string | undefined }[] = [];
const realOpen = window.open;

before(async () => {
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    opened.push({ url: String(url ?? ""), target, features });
    return null;
  }) as typeof window.open;
  explorers = await import("../src/explorers.ts");
  ({ AddressChip } = await import("../src/kit/AddressChip.tsx"));
  ({ TransferTable } = await import("../src/panels/TransferTable.tsx"));
});

afterEach(async () => {
  await cleanup();
  opened.length = 0;
});

test("explorers.ts: only the chains this project actually has data for", () => {
  assert.deepEqual(Object.keys(explorers.EXPLORERS).sort(), ["arbitrum", "base", "bnb", "ethereum", "lens", "optimism", "robinhood", "solana", "story", "zora"]);
});

test("explorers.ts: Arbitrum One, OP Mainnet, Zora, Lens Chain and the Data Network link to each chain's own real explorer", () => {
  const cases = [
    ["arbitrum", "Arbiscan", "https://arbiscan.io"],
    ["optimism", "Optimistic Etherscan", "https://optimistic.etherscan.io"],
    ["zora", "Zora Explorer", "https://explorer.zora.energy"],
    ["lens", "Lens Explorer", "https://explorer.lens.xyz"],
    ["story", "DataNetScan", "https://www.datanetscan.io"],
  ] as const;
  for (const [chain, name, origin] of cases) {
    assert.equal(explorers.explorerName(chain), name);
    assert.equal(explorers.explorerAddressUrl(chain, "0xabc"), `${origin}/address/0xabc`);
    assert.equal(explorers.explorerTxUrl(chain, "0xdef"), `${origin}/tx/0xdef`);
  }
});

test("explorers.ts: Base links to BaseScan's real address and tx pages", () => {
  assert.equal(explorers.explorerName("base"), "BaseScan");
  assert.equal(explorers.explorerAddressUrl("base", "0xabc"), "https://basescan.org/address/0xabc");
  assert.equal(explorers.explorerTxUrl("base", "0xdef"), "https://basescan.org/tx/0xdef");
});

test("AddressChip: a Base address opens on BaseScan, not Etherscan", async () => {
  const addr = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const r = await render(createElement(AddressChip as ComponentType<any>, { info: { address: addr, chain: "base" } }));
  const link = r.container.querySelector<HTMLButtonElement>('button[aria-label="View on BaseScan"]');
  assert.ok(link, "no 'View on BaseScan' button");
  link.click();
  assert.equal(opened[0]!.url, `https://basescan.org/address/${addr}`);
});

test("explorers.ts: Robinhood Chain links go to its own Blockscout instance, never Etherscan", () => {
  assert.equal(explorers.explorerName("robinhood"), "Blockscout");
  assert.equal(explorers.explorerAddressUrl("robinhood", "0xabc"), "https://robinhoodchain.blockscout.com/address/0xabc");
  assert.equal(explorers.explorerTxUrl("robinhood", "0xdef"), "https://robinhoodchain.blockscout.com/tx/0xdef");
});

test("explorers.ts: builds the real Etherscan/Solscan address and tx URLs", () => {
  assert.equal(explorers.explorerName("ethereum"), "Etherscan");
  assert.equal(explorers.explorerName("solana"), "Solscan");
  assert.equal(explorers.explorerAddressUrl("ethereum", "0xabc"), "https://etherscan.io/address/0xabc");
  assert.equal(explorers.explorerAddressUrl("solana", "9Wz"), "https://solscan.io/account/9Wz");
  assert.equal(explorers.explorerTxUrl("ethereum", "0xdef"), "https://etherscan.io/tx/0xdef");
  assert.equal(explorers.explorerTxUrl("solana", "5sig"), "https://solscan.io/tx/5sig");
  assert.equal(explorers.explorerName("bnb"), "BscScan");
  assert.equal(explorers.explorerAddressUrl("bnb", "0xabc"), "https://bscscan.com/address/0xabc");
  assert.equal(explorers.explorerTxUrl("bnb", "0xdef"), "https://bscscan.com/tx/0xdef");
});

test("AddressChip: copy-address and view-on-explorer buttons exist and the explorer one opens the right URL, per chain", async () => {
  const eth = await render(createElement(AddressChip, { info: { address: "0x1234567890123456789012345678901234567890", chain: "ethereum" } }));
  assert.ok(eth.container.querySelector('button[aria-label="Copy address"]'), "no copy-address button");
  const ethLink = eth.container.querySelector<HTMLButtonElement>('button[aria-label="View on Etherscan"]');
  assert.ok(ethLink, "no 'View on Etherscan' button");
  ethLink.click();
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.url, "https://etherscan.io/address/0x1234567890123456789012345678901234567890");
  assert.equal(opened[0]!.target, "_blank");

  const sol = await render(createElement(AddressChip, { info: { address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", chain: "solana" } }));
  const solLink = sol.container.querySelector<HTMLButtonElement>('button[aria-label="View on Solscan"]');
  assert.ok(solLink, "no 'View on Solscan' button");
  solLink.click();
  assert.equal(opened[1]!.url, "https://solscan.io/account/9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
});

test("AddressChip: showActions=false (used inside the Tracer's own search-result buttons, to avoid a <button> inside a <button>) renders neither action", async () => {
  const r = await render(createElement(AddressChip, { info: { address: "0xabc", chain: "ethereum" }, showActions: false }));
  assert.equal(r.container.querySelector('button[aria-label="Copy address"]'), null);
  assert.equal(r.container.querySelector('button[aria-label="View on Etherscan"]'), null);
});

function fakeTransfer(overrides: Partial<Record<string, unknown>> = {}) {
  const addr = (a: string, chain: "ethereum" | "solana") => ({ address: a, chain });
  return {
    id: "t1_0",
    chain: "solana" as const,
    txHash: "5sigExampleTransactionSignature",
    blockNumber: 1,
    blockTimestamp: "2026-01-01T00:00:00.000Z",
    from: addr("FromAddr111111111111111111111111111111111", "solana"),
    to: addr("ToAddr2222222222222222222222222222222222222", "solana"),
    tokenId: "native",
    tokenSymbol: "SOL",
    tokenName: "Solana",
    tokenDecimals: 9,
    amountRaw: "1000000000",
    amount: "1",
    usd: 100,
    priceSource: "test",
    ...overrides,
  };
}

test("TransferTable: a row's time cell has a 'view transaction on <explorer>' button that opens the real tx URL and doesn't trigger row selection", async () => {
  let selected: unknown = null;
  const t = fakeTransfer();
  const r = await render(
    createElement(TransferTable, {
      rows: [t],
      label: "Transfers",
      onSelect: (row: unknown) => {
        selected = row;
      },
    }),
  );
  const btn = r.container.querySelector<HTMLButtonElement>('button[aria-label="View transaction on Solscan"]');
  assert.ok(btn, "no 'View transaction on Solscan' button in the time cell");
  btn.click();
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.url, "https://solscan.io/tx/5sigExampleTransactionSignature");
  assert.equal(selected, null, "clicking the explorer-link button must not also select the row");
});
