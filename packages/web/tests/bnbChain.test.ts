// BNB Smart Chain as an app-wide chain in the web UI: the shared picker offers it (and the pickers
// for the older two-chain services don't), its mark renders, and the address/label helpers accept a
// 0x address on BNB instead of folding it into Ethereum.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement, useState } from "react";
import { act } from "react";
import "./harness/env.ts";
import { cleanup, render } from "./harness/render.ts";
import type { Chain } from "@osstrace/contract";

const ADDR = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

afterEach(cleanup);

async function openPicker(chains?: readonly Chain[]) {
  const { ChainSelect } = await import("../src/ChainSelect.tsx");
  const picked: string[] = [];
  function Harness() {
    const [value, setValue] = useState<Chain>("ethereum");
    return createElement(ChainSelect, {
      value,
      onChange: (c: Chain) => {
        picked.push(c);
        setValue(c);
      },
      ...(chains ? { chains } : {}),
    });
  }
  const r = await render(createElement(Harness));
  const button = r.container.querySelector<HTMLButtonElement>("button[aria-haspopup='listbox']")!;
  await act(async () => button.click());
  const options = [...r.container.querySelectorAll<HTMLLIElement>("li[role='option']")];
  return { r, button, options, picked };
}

test("ChainSelect: offers BNB Chain alongside Ethereum and Solana, with BNB's mark in its brand yellow", async () => {
  const { r, button, options, picked } = await openPicker();
  assert.deepEqual(
    options.map((o) => o.textContent),
    ["Ethereum", "Solana", "BNB Chain", "Robinhood Chain"],
  );
  const bnb = options[2]!;
  assert.equal(bnb.querySelector("path")?.getAttribute("fill"), "#F0B90B");
  await act(async () => bnb.click());
  assert.deepEqual(picked, ["bnb"]);
  assert.equal(button.getAttribute("aria-label"), "Chain: BNB Chain");
  assert.ok(r.container.querySelector("button path[fill='#F0B90B']"), "the closed picker shows the BNB mark");
});

test("ChainSelect: a picker for a two-chain legacy service never offers BNB", async () => {
  const { LEGACY_SERVICE_CHAINS } = await import("../src/ChainSelect.tsx");
  const { options } = await openPicker(LEGACY_SERVICE_CHAINS);
  assert.deepEqual(
    options.map((o) => o.textContent),
    ["Ethereum", "Solana"],
  );
});

test("validateAddress: a 0x address is valid on BNB Chain, a Solana one isn't, with a BNB-specific message", async () => {
  const { validateAddress } = await import("../src/kit/validation.ts");
  assert.equal(validateAddress("bnb", ADDR), null);
  assert.equal(validateAddress("bnb", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"), "Not a BNB Chain address (0x followed by 40 hex characters).");
  assert.equal(validateAddress("ethereum", "nope"), "Not an Ethereum address (0x followed by 40 hex characters).");
});

test("labels import: a bnb row is accepted, kept apart from the same address on ethereum", async () => {
  const { parseLabelsImport } = await import("../src/labels/labelsImport.ts");
  const preview = parseLabelsImport(`chain,address,name\nbnb,${ADDR.toLowerCase()},BSC hot\nethereum,${ADDR},ETH hot\nbitcoin,${ADDR},nope`, "csv");
  const rows = preview.rows;
  assert.equal(rows[0]!.errors.length, 0);
  assert.equal(rows[0]!.chain, "bnb");
  assert.equal(rows[1]!.errors.length, 0, "same address on another chain is not a duplicate");
  assert.match(rows[2]!.errors[0]!, /Unknown chain "bitcoin" \(use solana, ethereum, bnb, robinhood\)/);
});

test("ChainBadge names BNB Chain, short and long", async () => {
  const { ChainBadge } = await import("../src/kit/ChainBadge.tsx");
  const r = await render(createElement("div", null, createElement(ChainBadge, { chain: "bnb" }), createElement(ChainBadge, { chain: "bnb", long: true })));
  const badges = [...r.container.querySelectorAll("span[title]")];
  assert.deepEqual(
    badges.map((b) => [b.getAttribute("title"), b.textContent]),
    [
      ["BNB Chain", "BNB"],
      ["BNB Chain", "BNB Chain"],
    ],
  );
});
