import { test } from "node:test";
import assert from "node:assert/strict";
import { amountDisplay } from "../src/txDisplay.ts";

test("a failed (reverted) transaction is never shown with a +/- sign or a direction colour", () => {
  // The Lookup view used to sign and colour by direction alone, so a reverted "send 5 ETH"
  // rendered as "-5 ETH" in outbound orange, identical to a real transfer.
  for (const direction of ["in", "out", "self"] as const) {
    assert.deepEqual(amountDisplay(direction, "failed"), { failed: true, sign: "", tone: "neutral" }, direction);
  }
});

test("a successful or unchecked transaction is signed and coloured by its direction", () => {
  for (const status of ["success", undefined] as const) {
    assert.deepEqual(amountDisplay("in", status), { failed: false, sign: "+", tone: "inbound" });
    assert.deepEqual(amountDisplay("out", status), { failed: false, sign: "-", tone: "outbound" });
    assert.deepEqual(amountDisplay("self", status), { failed: false, sign: "", tone: "neutral" });
  }
});
