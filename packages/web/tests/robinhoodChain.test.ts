// Robinhood Chain as an app-wide chain in the web UI: the shared picker offers it (the pickers for the
// older two-chain services don't), its mark renders, its links go to its own Blockscout, and -- the
// trap specific to this chain -- nothing that names a *chain* shows its native "ETH", which would make
// it indistinguishable from Ethereum.
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

test("ChainSelect: offers Robinhood Chain, with its feather on the lime disc", async () => {
  const { button, options, picked } = await openPicker();
  const rh = options.find((o) => o.textContent === "Robinhood Chain");
  assert.ok(rh, "Robinhood Chain is offered");
  assert.equal(rh.querySelector("circle")?.getAttribute("fill"), "#CCFF00");
  await act(async () => rh.click());
  assert.deepEqual(picked, ["robinhood"]);
  assert.equal(button.getAttribute("aria-label"), "Chain: Robinhood Chain");
});

test("ChainSelect: a picker for a two-chain legacy service never offers Robinhood Chain", async () => {
  const { LEGACY_SERVICE_CHAINS } = await import("../src/ChainSelect.tsx");
  const { options } = await openPicker(LEGACY_SERVICE_CHAINS);
  assert.ok(!options.some((o) => o.textContent === "Robinhood Chain"));
});

test("ChainBadge: Robinhood Chain's short code is RH, never its native ETH", async () => {
  const { ChainBadge, CHAIN_SHORT } = await import("../src/kit/ChainBadge.tsx");
  const r = await render(createElement("div", null, createElement(ChainBadge, { chain: "robinhood" }), createElement(ChainBadge, { chain: "robinhood", long: true })));
  const badges = [...r.container.querySelectorAll("span[title]")].map((b) => [b.getAttribute("title"), b.textContent]);
  assert.deepEqual(badges, [
    ["Robinhood Chain", "RH"],
    ["Robinhood Chain", "Robinhood Chain"],
  ]);
  assert.notEqual(CHAIN_SHORT.robinhood, CHAIN_SHORT.ethereum);
});

test("validateAddress and labels import: a 0x address is valid on Robinhood Chain and kept apart from Ethereum's", async () => {
  const { validateAddress } = await import("../src/kit/validation.ts");
  assert.equal(validateAddress("robinhood", ADDR), null);
  assert.equal(validateAddress("robinhood", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"), "Not a Robinhood Chain address (0x followed by 40 hex characters).");
  const { parseLabelsImport } = await import("../src/labels/labelsImport.ts");
  const rows = parseLabelsImport(`chain,address,name\nrobinhood,${ADDR.toLowerCase()},RH hot\nethereum,${ADDR},ETH hot`, "csv").rows;
  assert.equal(rows[0]!.chain, "robinhood");
  assert.equal(rows[0]!.errors.length, 0);
  assert.equal(rows[1]!.errors.length, 0, "the same address on Ethereum is not a duplicate");
});

test("explorer links for a Robinhood Chain address and transaction go to robinhoodchain.blockscout.com", async () => {
  const { explorerAddressUrl, explorerTxUrl, explorerName } = await import("../src/explorers.ts");
  assert.equal(explorerName("robinhood"), "Blockscout");
  assert.equal(explorerAddressUrl("robinhood", ADDR), `https://robinhoodchain.blockscout.com/address/${ADDR}`);
  assert.equal(explorerTxUrl("robinhood", "0xabc"), "https://robinhoodchain.blockscout.com/tx/0xabc");
});
